import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExtractionEngine } from "../scripts/lib/extraction.mjs";

// Exact semantic changes approved on 2026-10-12T16:13:40Z.
// Source 57709977ff0a3551194e4baae5ab8f0daa7e1870, reference 659,
// description sentence 2, line 3 columns 47–71.
const text = "人民日报客户端报道：四部门联手，对“速成车”说不。";
const term = "四部门联手，对“速成车”说不";
const rules = JSON.parse(await readFile(new URL("../data/extraction-rules.json", import.meta.url)));
const withoutProposal = structuredClone(rules);
const topic = withoutProposal.topics.find((item) => item.conceptId === "topic-manufacturing");
topic.extractionTriggers = topic.extractionTriggers.filter((item) => item !== term);
const baseline = createExtractionEngine(withoutProposal);
const proposal = structuredClone(withoutProposal);
proposal.topics.find((item) => item.conceptId === topic.conceptId).extractionTriggers.push(term);
const proposed = createExtractionEngine(rules);
assert.deepEqual(rules, proposal);

test("reference 659 entity gap is reproduced without the approved literal", () => {
  assert.deepEqual(baseline.extractCandidates(text, text), []);
  assert.deepEqual(baseline.matchTopicEvidence(text), []);
  assert.equal(baseline.classifyEvent(text, text), "other");
});

test("reference 659 approved rule supplies only its existing manufacturing topic", () => {
  const entities = proposed.extractCandidates(text, text);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].type, "topic");
  assert.equal(entities[0].label, topic.label);
  assert.deepEqual(proposed.matchTopicEvidence(text), [{ entityId: topic.entityId, terms: [term] }]);
  assert.equal(proposed.classifyEvent(text, text), "economy_business");
});

test("reference 659 literal rule does not generalize to unrelated wording", () => {
  for (const unrelated of ["四部门联手", "对“速成课程”说不", "速成车", "尊界刹车门持续发酵", "回应产品安全问题能不能说人话"]) {
    assert.deepEqual(proposed.extractCandidates(unrelated, unrelated), baseline.extractCandidates(unrelated, unrelated), unrelated);
    assert.deepEqual(proposed.matchTopicEvidence(unrelated), baseline.matchTopicEvidence(unrelated), unrelated);
  }
});


test("reference 659 and the older title exclude the exact downfall predicate as a person", () => {
  for (const fragment of ["广州“砍树书记”倒台；武汉原市长周先旺被判刑。", "中医药局长倒台"]) {
    assert.ok(!proposed.extractCandidates(fragment, fragment).some((entity) => entity.type === "person" && entity.label === "倒台"));
  }
});

test("exact predicate exclusion preserves supported person extraction", () => {
  const fragment = "美国总统拜登在北京市表示";
  assert.ok(proposed.extractCandidates(fragment, fragment).some((entity) => entity.type === "person" && entity.label === "拜登"));
});
