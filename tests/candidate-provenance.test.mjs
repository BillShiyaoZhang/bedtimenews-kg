import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createHash } from "node:crypto";
import { parseSourcePage } from "../scripts/lib/news.mjs";
import { buildKnowledgeGraph } from "../scripts/lib/kg-build.mjs";
import { compileOntology } from "../scripts/lib/ontology-compiler.mjs";
import { buildCandidateProvenance, validateCandidateProvenance } from "../scripts/lib/candidate-provenance.mjs";
import { canonicalJson, diffRecords } from "../scripts/lib/candidate-bundle.mjs";
const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const [ontology, rules, template, ontologySource, patterns] = await Promise.all(["../data/ontology.json", "../data/extraction-rules.json", "../data/processed/news.json", "../data/ontology-source.json", "../data/extraction-patterns.json"].map(read));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bindings = Object.fromEntries(["segmentationHash", "overridesHash", "ontologyHash", "rulesHash", "generatorHash"].map((key) => [key, hash(key)]));
function fixture(custom = {}) {
  const rows = [
    ["daily/2026-01-01.md", "华为比亚迪公布工资安排", "工资与排班", "华为和比亚迪在北京市公布工资与排班安排。"],
    ["daily/2026-01-02.md", "华为比亚迪介绍研究", "研究进展", "华为和比亚迪在北京市介绍研究进展。"],
    ["daily/2026-01-03.md", "北京市发布说明", "北京市介绍有关情况。", "北京市介绍有关情况。\n\n" + "这段说明记录普通背景，相关安排仍在讨论中。".repeat(30) + "\n\n后来华为和比亚迪继续介绍情况。"],
    ["daily/2026-01-04.md", "工资讨论", "北京市说明", "北京市介绍有关情况。<!-- 排班 -->"],
    ["daily/2026-01-05.md", "重复来源样本", "北京市说明", "北京市介绍有关情况。<!-- 排班 -->"],
  ];
  const rawPages = new Map(); const sourceInventory = {}; const pages = []; const news = [];
  for (const [path, title, description, body] of rows) {
    const raw = `---\ntitle: ${title}\ndescription: ${description}\npublished: true\ndateCreated: ${path.match(/\d{4}-\d{2}-\d{2}/u)[0]}T00:00:00Z\n---\n\n# 相关新闻\n\n${body}\n`;
    const parsed = parseSourcePage(path, raw);
    pages.push(parsed.page); news.push(...parsed.news);
    rawPages.set(parsed.page.id, raw); sourceInventory[path] = hash(raw);
  }
  const dataset = { ...template, generatedAt: "2026-01-05T00:00:00Z", pages, news };
  const actualRules = custom.rules ?? rules;
  const actualOntology = custom.ontology ?? ontology;
  const build = buildKnowledgeGraph({ dataset, rawPages, ontology: actualOntology, rules: actualRules, generatedAt: dataset.generatedAt, collectTrace: true });
  const options = { ...build, dataset, rawPages, sourceInventory, ontology: actualOntology, rules: actualRules, bindings };
  return { ...options, provenance: buildCandidateProvenance(options) };
}

test("candidate ledger covers every link, classification and chronology with replayable supports", () => {
  const value = fixture();
  assert.deepEqual(validateCandidateProvenance(value.provenance, value), []);
  assert.equal(value.provenance.assertions.length, value.kg.events.reduce((sum, event) => sum + event.entityIds.length + 1 + (event.actionAssessment ? 1 + event.actionAssessment.assignments.length : 0) + (event.reportingFormAssessment ? 1 + event.reportingFormAssessment.assignments.length : 0) + (event.numericObservationAssessment ? 1 + event.numericObservationAssessment.observations.length : 0), 0) + value.kg.eventRelations.length);
  assert.ok(value.provenance.observations.length > value.provenance.retention.length);
  assert.equal(value.provenance.epistemicScope, "extraction_assignment");
  assert.ok(value.provenance.supports.every((support) => value.provenance.assertions.some((assertion) => assertion.id === support.assertionId)));
  assert.ok(value.provenance.chronologyGroups.length > 0);
  const relationCounts = new Map();
  for (const support of value.provenance.supports.filter((support) => support.method === "news_date_chronology")) {
    assert.equal(support.newsRevisionIds.length, 2); assert.equal(support.dateDerivationIds.length, 2); assert.equal(support.prerequisiteIds.length, 2);
    relationCounts.set(support.relationId, (relationCounts.get(support.relationId) ?? 0) + 1);
  }
  assert.ok([...relationCounts.values()].some((count) => count >= 2), "preserve all via-entity supports after pair deduplication");
});

test("title-only topics stay derived-field supports without forged fragment evidence", () => {
  const value = fixture(); const event = value.kg.events.find((event) => event.title === "工资讨论");
  const labor = rules.topics.find((topic) => topic.id === "topic-labor").entityId;
  assert.ok(event.entityIds.includes(labor));
  assert.ok(!event.topicEvidence.some((match) => match.entityId === labor));
  const assignment = value.provenance.assertions.find((row) => row.subject === event.id && row.object === labor);
  const support = value.provenance.supports.find((row) => row.assertionId === assignment.id);
  const observation = value.provenance.observations.find((row) => row.id === support.observationId);
  const evidence = value.provenance.evidence.find((row) => row.id === observation.evidenceIds[0]);
  const input = value.provenance.inputs.find((row) => row.id === evidence.inputId);
  assert.equal(input.origin, "mixed_fragment_and_derived_fields");
  assert.equal(evidence.text, "工资");
});

test("global rescan is explicit and cannot bootstrap direct retention", () => {
  const value = fixture();
  const event = value.kg.events.find((row) => row.title === "北京市发布说明");
  const huawei = value.kg.entities.find((row) => row.label === "华为");
  assert.ok(event.entityIds.includes(huawei.id));
  const assignment = value.provenance.assertions.find((row) => row.subject === event.id && row.object === huawei.id);
  assert.ok(value.provenance.supports.some((row) => row.assertionId === assignment.id && row.method === "global_name_rescan"));
  const retained = value.provenance.retention.find((row) => row.entityId === huawei.id);
  assert.equal(retained.distinctNewsCount, 2);
  assert.equal(huawei.extraction.eventCount, 3);
  assert.ok(value.provenance.retention.some((row) => !row.retained) || value.provenance.retention.length > 0);
});

test("ledger is deterministic under news/page permutations and does not persist raw sources", () => {
  const value = fixture(); const dataset = { ...value.dataset, news: [...value.dataset.news].reverse(), pages: [...value.dataset.pages].reverse() };
  const rebuilt = buildKnowledgeGraph({ ...value, dataset, generatedAt: dataset.generatedAt, collectTrace: true });
  const reordered = buildCandidateProvenance({ ...value, ...rebuilt, dataset });
  assert.equal(canonicalJson(value.provenance), canonicalJson(reordered));
  assert.equal(canonicalJson(value.kg), canonicalJson(rebuilt.kg));
  const serialized = canonicalJson(value.provenance);
  for (const raw of value.rawPages.values()) assert.ok(!serialized.includes(raw));
  assert.ok(value.provenance.evidence.every((row) => !Object.hasOwn(row, "ranges") && row.firstRange.length === 2));
  assert.ok(value.provenance.duplicateContentGroups.length > 0);
  assert.ok(value.provenance.duplicateContentGroups.every((group) => group.independence === "not_established"));
});

test("omitted supports, forged witnesses, cross-news inputs and dangling prerequisites fail replay", () => {
  const value = fixture();
  for (const corrupt of [
    (p) => p.supports.pop(),
    (p) => { p.evidence[0].firstRange[0] += 1; },
    (p) => { p.evidence[0].text = "伪造"; },
    (p) => { p.inputs[0].newsRevisionId = p.inputs.find((row) => row.newsRevisionId !== p.inputs[0].newsRevisionId).newsRevisionId; },
    (p) => { p.supports.find((row) => row.prerequisiteIds).prerequisiteIds = ["missing"]; },
    (p) => { p.classifications[0].type = "fake-unknown-domain"; },
  ]) {
    const invalid = structuredClone(value.provenance); corrupt(invalid);
    assert.ok(validateCandidateProvenance(invalid, value).length);
  }
  const tampered = new Map(value.rawPages); const [id, raw] = [...tampered][0]; tampered.set(id, raw + "\nsource changed outside fragment\n");
  assert.ok(validateCandidateProvenance(value.provenance, { ...value, rawPages: tampered }).length);
});

test("candidate rule-support removal preserves surviving assignments and exposes final loss", () => {
  const before = fixture();
  const event = before.kg.events.find((row) => row.title === "华为比亚迪公布工资安排");
  const laborId = rules.topics.find((row) => row.id === "topic-labor").entityId;
  const assignment = before.provenance.assertions.find((row) => row.subject === event.id && row.object === laborId);
  const nextPatterns = structuredClone(patterns);
  const labor = nextPatterns.topics.find((row) => row.conceptId === "topic-labor");
  labor.extractionTriggers = labor.extractionTriggers.filter((term) => term !== "工资");
  const compiled = compileOntology(ontologySource, nextPatterns);
  const after = fixture(compiled);
  assert.ok(after.provenance.assertions.some((row) => row.id === assignment.id));
  assert.ok(diffRecords(before.provenance, after.provenance, { collections: ["supports"] }).summary.removed > 0);
  labor.extractionTriggers = ["仅测试没有出现的信号"];
  const without = fixture(compileOntology(ontologySource, nextPatterns));
  assert.ok(!without.provenance.assertions.some((row) => row.id === assignment.id));
  assert.equal(before.sourceInventory["daily/2026-01-01.md"], without.sourceInventory["daily/2026-01-01.md"]);
});

test("second direct occurrence rematerializes older links but rescans alone never retain an entity", () => {
  const value = fixture();
  const second = value.dataset.news.find((news) => news.title === "华为比亚迪介绍研究");
  const smaller = { ...value.dataset, news: value.dataset.news.filter((news) => news.id !== second.id), pages: value.dataset.pages.filter((page) => page.id !== second.pageId) };
  const before = buildKnowledgeGraph({ ...value, dataset: smaller, generatedAt: smaller.generatedAt, collectTrace: true });
  assert.ok(!before.kg.entities.some((entity) => entity.label === "华为"));
  assert.ok(before.trace.retention.some((row) => row.label === "华为" && !row.retained && row.directEventIds.length === 1));
  const after = value.kg;
  const huawei = after.entities.find((entity) => entity.label === "华为");
  assert.ok(huawei);
  const oldEventIds = new Set(before.kg.events.map((event) => event.id));
  assert.equal(after.events.filter((event) => oldEventIds.has(event.id) && event.entityIds.includes(huawei.id)).length, 2);
});

function chronologyFixture(dayIndexes) {
  const pages = []; const news = []; const rawPages = new Map();
  for (const index of dayIndexes) {
    const date = new Date(Date.UTC(2026, 0, index)).toISOString().slice(0, 10);
    const path = `daily/${date}.md`;
    const raw = `---\ntitle: 美国情况\npublished: true\ndateCreated: ${date}T00:00:00Z\n---\n\n美国介绍情况。\n`;
    const parsed = parseSourcePage(path, raw); pages.push(parsed.page); news.push(...parsed.news); rawPages.set(parsed.page.id, raw);
  }
  const dataset = { ...template, generatedAt: "2026-01-01T00:00:00Z", pages, news };
  return buildKnowledgeGraph({ dataset, rawPages, ontology, rules, generatedAt: dataset.generatedAt, collectTrace: true });
}

test("candidate chronology recomputes middle insertions and place mention-cap boundaries", () => {
  const before = chronologyFixture([1, 3]);
  const inserted = chronologyFixture([3, 1, 2]);
  assert.equal(before.kg.eventRelations.length, 1);
  assert.equal(inserted.kg.eventRelations.length, 2);
  assert.ok(!inserted.kg.eventRelations.some((relation) => relation.id === before.kg.eventRelations[0].id));
  const atCap = chronologyFixture(Array.from({ length: 90 }, (_, index) => index + 1));
  const aboveCap = chronologyFixture(Array.from({ length: 91 }, (_, index) => index + 1));
  assert.equal(atCap.kg.eventRelations.length, 89);
  assert.equal(aboveCap.kg.eventRelations.length, 0);
  assert.ok(atCap.trace.chronology.every((row) => row.maximumMentions === 90));
});


test("undated pages retain explicit fragment-date fallback rather than false publication provenance", () => {
  const raw = "---\ntitle: 美国消息\npublished: true\n---\n\n2026年1月1日，美国介绍有关情况。\n";
  const parsed = parseSourcePage("daily/undated.md", raw);
  assert.equal(parsed.page.publishedAt, "1900-01-01");
  assert.equal(parsed.news[0].date, "2026-01-01");
  const dataset = { ...template, generatedAt: "2026-01-01T00:00:00Z", pages: [parsed.page], news: parsed.news };
  const rawPages = new Map([[parsed.page.id, raw]]);
  const build = buildKnowledgeGraph({ dataset, rawPages, ontology, rules, generatedAt: dataset.generatedAt, collectTrace: true });
  const value = { ...build, dataset, rawPages, ontology, rules, sourceInventory: { "daily/undated.md": hash(raw) }, bindings };
  const provenance = buildCandidateProvenance(value);
  const date = provenance.dateDerivations[0];
  assert.equal(date.kind, "fragment_explicit_date");
  assert.equal(date.newsRevisionId, provenance.newsRevisions[0].id);
  const evidence = provenance.evidence.find((row) => row.id === date.evidenceId);
  assert.equal(evidence.text, "2026年1月1日");
  assert.equal(provenance.inputs.find((row) => row.id === evidence.inputId).origin, "verified_fragment");
  assert.match(provenance.chronologySemantics, /fragment_fallback_not_actual_occurrence/u);
  assert.deepEqual(validateCandidateProvenance(provenance, value), []);
});
