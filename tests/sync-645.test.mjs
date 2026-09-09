import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExtractionEngine } from "../scripts/lib/extraction.mjs";
import {
  createEventSearchDocument,
  matchesSearchDocument,
  parseSearchQuery,
} from "../app/lib/search.mjs";

const rules = JSON.parse(await readFile(new URL("../data/extraction-rules.json", import.meta.url), "utf8"));
const ontology = JSON.parse(await readFile(new URL("../data/ontology.json", import.meta.url), "utf8"));
const extractor = createExtractionEngine(rules);
// Verbatim description fragments from reference/601-700/645.md at
// upstream 06fc723c88b9bc519eba4bb137742408c4f4b33f.
const policy = "三部门出台指引，缓解车企内卷外溢";
const business = "多家中企在匈牙利遇挫";
const labor = "星宇股份员工内外有别，丁仲礼之问还在发力：中国人是不是人";

test("vehicle guidance has a manufacturing topic and a policy event type", () => {
  const candidates = extractor.extractCandidates(policy, policy);
  assert.ok(candidates.some((item) => item.type === "topic" && item.label === "产业与制造"));
  assert.equal(extractor.classifyEvent(policy, policy), "policy_governance");
  assert.equal(candidates.some((item) => ["organization", "policy"].includes(item.type)), false);
});

test("overseas Chinese-company setbacks retain their place and business type", () => {
  const candidates = extractor.extractCandidates(business, business);
  assert.ok(candidates.some((item) => item.type === "place" && item.label === "匈牙利"));
  assert.equal(extractor.classifyEvent(business, business), "economy_business");
  assert.equal(candidates.some((item) => item.type === "organization"), false);
});

test("unequal employee treatment has labor semantics and the source-named company", () => {
  const candidates = extractor.extractCandidates(labor, labor);
  assert.ok(candidates.some((item) => item.type === "topic" && item.label === "就业与劳动"));
  assert.ok(candidates.some((item) => item.type === "organization" && item.label === "星宇股份"));
  assert.equal(extractor.classifyEvent(labor, labor), "society_livelihood");
  // An unconfirmed role or an unnamed policy must not be manufactured.
  assert.equal(candidates.some((item) => ["person", "policy", "document", "facility"].includes(item.type)), false);
  const earlier = "星宇股份羞辱式劝退应届生，被投诉至港交所";
  assert.ok(extractor.extractCandidates(earlier, earlier).some((item) => item.label === "星宇股份"));
});

test("reviewed employee and company phrases do not match unrelated fragments", () => {
  for (const title of ["员工参加合影", "建筑内外有别", "星宇闪耀"]) {
    const candidates = extractor.extractCandidates(title, title);
    assert.equal(candidates.some((item) => ["就业与劳动", "星宇股份"].includes(item.label)), false, title);
  }
});

test("a company setback phrase does not override sanctions or nonbusiness setbacks", () => {
  const sanctions = "欧盟以向俄出售设备为由拟制裁7家中企，商务部：勿开恶劣先河";
  assert.equal(extractor.classifyEvent(sanctions, sanctions), "conflict_security");
  const sports = "运动员在匈牙利遇挫";
  assert.equal(extractor.classifyEvent(sports, sports), "education_culture");
});

test("new sync fragments can be found by source words, semantic topics, and event types", () => {
  for (const [title, queries] of [
    [policy, ["车企", "出台指引", "产业与制造", "政策与治理"]],
    [business, ["中企 匈牙利", "经济与商业"]],
    [labor, ["星宇股份", "就业与劳动", "社会与民生"]],
  ]) {
    const type = extractor.classifyEvent(title, title);
    const document = createEventSearchDocument({
      event: { title, summary: title, type, date: "2026-09-08" },
      entities: extractor.extractCandidates(title, title),
      eventType: ontology.eventTypes.find((item) => item.id === type),
    });
    for (const query of queries) {
      assert.equal(matchesSearchDocument(document, parseSearchQuery(query)), true, `${query}: ${title}`);
    }
  }
});
