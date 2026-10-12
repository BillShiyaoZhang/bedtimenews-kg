import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExtractionEngine } from "../scripts/lib/extraction.mjs";

// Review-only experiment: no production rule or accepted data is changed here.
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
const proposed = createExtractionEngine(proposal);

test("reference 659 entity gap is reproduced without the unapproved literal proposal", () => {
  assert.deepEqual(baseline.extractCandidates(text, text), []);
  assert.deepEqual(baseline.matchTopicEvidence(text), []);
  assert.equal(baseline.classifyEvent(text, text), "other");
});

test("reference 659 review proposal supplies only its existing manufacturing topic", () => {
  const entities = proposed.extractCandidates(text, text);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].type, "topic");
  assert.equal(entities[0].label, topic.label);
  assert.deepEqual(proposed.matchTopicEvidence(text), [{ entityId: topic.entityId, terms: [term] }]);
  assert.equal(proposed.classifyEvent(text, text), "economy_business");
});

test("reference 659 literal proposal does not generalize to unrelated wording", () => {
  for (const unrelated of ["四部门联手", "对“速成课程”说不", "速成车", "尊界刹车门持续发酵", "回应产品安全问题能不能说人话"]) {
    assert.deepEqual(proposed.extractCandidates(unrelated, unrelated), baseline.extractCandidates(unrelated, unrelated), unrelated);
    assert.deepEqual(proposed.matchTopicEvidence(unrelated), baseline.matchTopicEvidence(unrelated), unrelated);
  }
});
