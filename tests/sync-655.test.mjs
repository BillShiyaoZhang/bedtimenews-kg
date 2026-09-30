import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExtractionEngine } from "../scripts/lib/extraction.mjs";
import { createEventSearchDocument, matchesSearchDocument, parseSearchQuery } from "../app/lib/search.mjs";

const rules = JSON.parse(await readFile(new URL("../data/extraction-rules.json", import.meta.url), "utf8"));
const ontology = JSON.parse(await readFile(new URL("../data/ontology.json", import.meta.url), "utf8"));
const extractor = createExtractionEngine(rules);
// Exact failing fragments at upstream 907bde68b02b8c2cfd82617ea3555c6d81a9ea43.
const cases = [
  ["中秋假期没调休，但国庆假期有两天调休，影响一个月的排班。", "就业与劳动", "society_livelihood", "调休"],
  ["经济日报：假期不能只算纸面天数，更要考量真实的休息质量。", "就业与劳动", "society_livelihood", "休息质量"],
  ["顶流经济学家争论“投资于谁”，继续投资拉动还是直达居民部门。", "宏观经济", "economy_business", "居民部门"],
];

for (const [text, topic, expectedType, sourceQuery] of cases) {
  test(`reference 655 preserves evidence-backed semantics: ${sourceQuery}`, () => {
    const entities = extractor.extractCandidates(text, text);
    const type = extractor.classifyEvent(text, text);
    assert.ok(entities.some((entity) => entity.type === "topic" && entity.label === topic));
    assert.equal(type, expectedType);
    assert.equal(entities.some((entity) => ["person", "policy", "document"].includes(entity.type)), false);
    const document = createEventSearchDocument({
      event: { title: text, summary: text, type }, entities,
      eventType: ontology.eventTypes.find((item) => item.id === type),
    });
    for (const query of [sourceQuery, topic, ontology.eventTypes.find((item) => item.id === type).label]) {
      assert.equal(matchesSearchDocument(document, parseSearchQuery(query)), true, query);
    }
  });
}

test("holiday and investment vocabulary does not create unrelated labor or macroeconomic topics", () => {
  for (const text of ["假期旅游价格上涨", "国庆电影票房增长", "经济日报报道足球比赛", "学校停课调休"]) {
    assert.equal(extractor.extractCandidates(text, text).some((entity) => entity.label === "就业与劳动"), false, text);
  }
  for (const text of ["公司投资建设工厂", "居民参加社区活动"]) {
    assert.equal(extractor.extractCandidates(text, text).some((entity) => entity.label === "宏观经济"), false, text);
  }
  assert.equal(extractor.classifyEvent("调休期间工厂发生火灾事故", ""), "disaster_accident");
});

test("investment-led growth and household-sector phrases each identify macroeconomy", () => {
  for (const text of ["投资拉动", "居民部门"]) {
    assert.ok(extractor.extractCandidates(text, text).some((entity) => entity.label === "宏观经济"), text);
  }
});
