import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExtractionEngine } from "../scripts/lib/extraction.mjs";

const rules = JSON.parse(
  await readFile(new URL("../data/extraction-rules.json", import.meta.url)),
);
const extractor = createExtractionEngine(rules);

test("extractor separates subjects, places, policies, documents, and topics", () => {
  const text =
    "美国总统拜登在北京市表示，中国人民银行将依据《金融稳定法》推进改革，《金融稳定报告》同时发布，人工智能产业也受到关注。";
  const values = extractor.extractCandidates(text, text);
  const identities = new Set(
    values.map((value) => `${value.type}:${value.label}`),
  );

  assert.ok(identities.has("person:拜登"));
  assert.ok(identities.has("place:美国"));
  assert.ok(identities.has("place:北京市"));
  assert.ok(identities.has("organization:中国人民银行"));
  assert.ok(identities.has("policy:《金融稳定法》"));
  assert.ok(identities.has("document:《金融稳定报告》"));
  assert.ok(identities.has("topic:人工智能"));
});

test("event classification uses reviewed universal categories", () => {
  assert.equal(
    extractor.classifyEvent("某地铁路正式开工建设"),
    "infrastructure_transport",
  );
  assert.equal(
    extractor.classifyEvent("法院对案件作出判决"),
    "law_justice",
  );
  assert.equal(
    extractor.classifyEvent("新一轮疫情防控与疫苗接种"),
    "public_health",
  );
});

test("reviewed vocabulary gives long-tail news a semantic entity", () => {
  for (const title of [
    "巴菲特再卖比亚迪并继续减持",
    "C919大型客机获颁生产许可证",
    "超级大乐透和双色球调整规则",
    "中国6岁女童接受基因编辑试验后死亡",
  ]) {
    assert.ok(
      extractor.extractCandidates(title, title).length > 0,
      `expected a semantic entity for: ${title}`,
    );
  }
});
