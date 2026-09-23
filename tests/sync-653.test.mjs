import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExtractionEngine } from "../scripts/lib/extraction.mjs";
import {
  createEventSearchDocument,
  matchesSearchDocument,
  parseSearchQuery,
} from "../app/lib/search.mjs";

const rules = JSON.parse(
  await readFile(new URL("../data/extraction-rules.json", import.meta.url), "utf8"),
);
const ontology = JSON.parse(
  await readFile(new URL("../data/ontology.json", import.meta.url), "utf8"),
);
const extractor = createExtractionEngine(rules);
// Exact description fragment at upstream 0a0320403b76ac50fba3e81cbb6d72d655a62248.
const housingStandard = "住建部明确，四层以上新建住宅装电梯的新国标已实施";

test("reference 653 housing standard has evidence-backed semantics", () => {
  const entities = extractor.extractCandidates(housingStandard, housingStandard);
  assert.ok(entities.some((entity) => entity.label === "住房与土地"));
  assert.equal(extractor.classifyEvent(housingStandard, housingStandard), "policy_governance");
  assert.equal(entities.some((entity) => ["document", "policy"].includes(entity.type)), false,
    "an unnamed national standard must not become an invented named document");
});

test("housing vocabulary preserves the reported action and avoids unrelated national-standard words", () => {
  for (const [text, type] of [
    ["新建住宅发生火灾", "disaster_accident"],
    ["新建住宅价格下降", "economy_business"],
    ["国标舞比赛", "education_culture"],
  ]) {
    assert.equal(extractor.classifyEvent(text, text), type, text);
  }
  assert.equal(extractor.extractCandidates("新建办公楼", "新建办公楼")
    .some((entity) => entity.label === "住房与土地"), false);
});

test("reference 653 housing standard is searchable by source wording, topic and event type", () => {
  const type = extractor.classifyEvent(housingStandard, housingStandard);
  const document = createEventSearchDocument({
    event: { title: housingStandard, summary: housingStandard, type },
    entities: extractor.extractCandidates(housingStandard, housingStandard),
    eventType: ontology.eventTypes.find((eventType) => eventType.id === type),
  });
  for (const query of [housingStandard, "新建住宅", "装电梯", "住房与土地", "政策与治理"]) {
    assert.equal(matchesSearchDocument(document, parseSearchQuery(query)), true, query);
  }
});
