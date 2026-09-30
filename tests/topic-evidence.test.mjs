import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import {
  createEventSearchDocument,
  matchesSearchDocument,
  parseSearchQuery,
} from "../app/lib/search.mjs";
import { validateTopicEvidenceStructure } from "../app/lib/topic-evidence.mjs";
import {
  createExtractionEngine,
  entityId,
  materializeEntity,
} from "../scripts/lib/extraction.mjs";
import { assertExtractionRules } from "../scripts/lib/extraction-rules.mjs";
import { appendNewRecords } from "../scripts/lib/incremental.mjs";
import { readNewsFragment } from "../scripts/lib/news.mjs";
import { validateTopicEvidence } from "../scripts/lib/topic-evidence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);
const [rules, ontology] = await Promise.all([
  readJson(resolve(root, "data/extraction-rules.json")),
  readJson(resolve(root, "data/ontology.json")),
]);
const engine = createExtractionEngine(rules);
const laborId = entityId("topic", "就业与劳动");
const macroId = entityId("topic", "宏观经济");
const bodyPath = "daily/2026/09/29.md";
const metadataPath = "reference/701-800/evidence-fixture.md";
const introduction = "北京市今日公布一项情况说明，介绍相关事项的背景与办理进展。这里保留完整的说明内容，方便读者了解具体情况，并在之后对照原始记录。";
const bodyRaw = `---
title: 证据测试日报
published: true
dateCreated: 2026-09-29T00:00:00Z
---

## 1、安排情况说明

${introduction}

这次安排涉及排班，也应考量真实的休息质量。

## 2、发展情况说明

${introduction}

这次讨论继续投资拉动，还是直达居民部门。

## 3、收入情况说明

${introduction}

这里仅记录工资变化的情况。

<!-- 排班、休息质量、投资拉动、居民部门不能从注释中进入检索。 -->

## 4、物价情况说明

${introduction}

这里仅讨论通胀变化的情况。
`;
const metadataRaw = `---
title: 证据测试参考信息
description: 北京市介绍休息质量改善情况。北京市公布居民部门调查结果。
published: true
dateCreated: 2026-09-30T00:00:00Z
---

## Tabs {.tabset}
`;
let fixture;

before(async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "topic-evidence-"));
  const sourceRoot = resolve(directory, "source");
  for (const [path, text] of [[bodyPath, bodyRaw], [metadataPath, metadataRaw]]) {
    await mkdir(dirname(resolve(sourceRoot, path)), { recursive: true });
    await writeFile(resolve(sourceRoot, path), text);
  }
  const newsPath = resolve(directory, "news.json");
  const kgPath = resolve(directory, "kg.json");
  fixture = { directory, sourceRoot, newsPath, kgPath };
  await run("scripts/build-news.mjs", [
    "--source", sourceRoot,
    "--include", "daily,reference",
    "--generated-at", "2026-09-30T00:00:00Z",
    "--output", newsPath,
  ]);
  await run("scripts/build-kg.mjs", [
    "--source", sourceRoot,
    "--news", newsPath,
    "--generated-at", "2026-09-30T00:00:00Z",
    "--output", kgPath,
  ]);
  fixture.dataset = await readJson(newsPath);
  fixture.kg = await readJson(kgPath);
});

after(async () => {
  if (fixture?.directory) await rm(fixture.directory, { recursive: true, force: true });
});

test("built news retains body-only topic evidence without lending it to sibling news", () => {
  assert.equal(fixture.dataset.news.length, 6);
  const cases = [
    ["安排情况说明", "收入情况说明", laborId, "就业与劳动", ["排班", "休息质量"]],
    ["发展情况说明", "物价情况说明", macroId, "宏观经济", ["投资拉动", "居民部门"]],
  ];
  for (const [title, siblingTitle, topicId, label, terms] of cases) {
    const event = fixture.kg.events.find((item) => item.title === title);
    const sibling = fixture.kg.events.find((item) => item.title === siblingTitle);
    assert.ok(event && sibling);
    assert.deepEqual(event.sourceIds, sibling.sourceIds);
    assert.ok(event.entityIds.includes(topicId));
    assert.ok(sibling.entityIds.includes(topicId));
    const evidence = event.topicEvidence.find((match) => match.entityId === topicId);
    assert.ok(evidence);
    for (const term of terms) {
      assert.equal(`${event.title}\n${event.summary}`.includes(term), false, `${term} must occur only in the body`);
      assert.ok(evidence.terms.includes(term), term);
      assert.equal(searchMatches(fixture.kg, event, term), true, term);
      assert.equal(searchMatches(fixture.kg, sibling, term), false, `${term} leaked to ${sibling.title}`);
    }
    assert.equal(searchMatches(fixture.kg, event, label), true);
    assert.equal(searchMatches(fixture.kg, sibling, label), true);
  }
  const income = fixture.kg.events.find((event) => event.title === "收入情况说明");
  assert.deepEqual(income.topicEvidence.find((match) => match.entityId === laborId).terms, ["工资"]);
  assert.equal(income.topicEvidence.some((match) => match.entityId === macroId), false);
  for (const topic of fixture.kg.entities.filter((entity) => entity.type === "topic")) {
    assert.deepEqual(topic.aliases, []);
  }
});

test("topic evidence accepts exact metadata fragments and passes publication validation", async () => {
  const metadataNews = fixture.dataset.news.filter((item) => item.fragment.sourceField === "frontmatter.description");
  assert.equal(metadataNews.length, 2);
  for (const item of metadataNews) {
    const fragment = readNewsFragment(metadataRaw, item.fragment);
    const event = fixture.kg.events.find((candidate) => candidate.newsId === item.id);
    assert.deepEqual(event.topicEvidence, engine.matchTopicEvidence(fragment));
    for (const match of event.topicEvidence) {
      for (const term of match.terms) assert.ok(fragment.includes(term));
    }
  }
  assert.deepEqual(await validateTopicEvidence(fixture.kg, fixture.dataset, rules, fixture.sourceRoot), []);
  await run("scripts/validate-kg.mjs", [fixture.kgPath, resolve(root, "data/ontology.json"), fixture.newsPath, fixture.sourceRoot]);
});

test("fixed-input news and topic evidence builds are byte deterministic", async () => {
  const newsPath = resolve(fixture.directory, "repeated-news.json");
  const kgPath = resolve(fixture.directory, "repeated-kg.json");
  await run("scripts/build-news.mjs", [
    "--source", fixture.sourceRoot,
    "--include", "daily,reference",
    "--generated-at", "2026-09-30T00:00:00Z",
    "--output", newsPath,
  ]);
  await run("scripts/build-kg.mjs", [
    "--source", fixture.sourceRoot,
    "--news", newsPath,
    "--generated-at", "2026-09-30T00:00:00Z",
    "--output", kgPath,
  ]);
  assert.deepEqual(await readFile(newsPath), await readFile(fixture.newsPath));
  assert.deepEqual(await readFile(kgPath), await readFile(fixture.kgPath));
});

test("reviewed topic aliases are searchable names and never implicit extraction triggers", () => {
  const reviewed = structuredClone(rules);
  const topic = reviewed.topics.find((item) => item.id === "topic-law");
  // This reviewed spelling is not supplied by the search module's synonym map.
  topic.aliases = ["法律及司法"];
  topic.extractionTriggers = ["判决"];
  const extractor = createExtractionEngine(reviewed);
  for (const text of ["法律及司法", "法律与司法"]) {
    assert.equal(extractor.extractCandidates(text).some((candidate) => candidate.label === topic.label), false);
    assert.equal(extractor.matchTopicEvidence(text).some((match) => match.entityId === entityId("topic", topic.label)), false);
  }
  const candidate = extractor.extractCandidates("判决").find((item) => item.label === topic.label);
  assert.deepEqual(candidate.aliases, ["法律及司法"]);
  const entity = materializeEntity({ ...candidate, eventCount: 1 });
  assert.deepEqual(entity.aliases, ["法律及司法"]);
  assert.equal(Object.hasOwn(entity, "extractionTriggers"), false);
  const event = { title: "情况说明", entityIds: [entity.id], topicEvidence: extractor.matchTopicEvidence("判决") };
  const document = createEventSearchDocument({ event, entities: [entity] });
  for (const query of ["法律与司法", "法律及司法", "判决"]) {
    assert.equal(matchesSearchDocument(document, parseSearchQuery(query)), true, query);
  }
});

test("title-only topic links do not manufacture fragment evidence", () => {
  const candidates = engine.extractCandidates("休息质量\n这是没有触发词的正文。");
  assert.ok(candidates.some((candidate) => candidate.label === "就业与劳动"));
  const topicEvidence = engine.matchTopicEvidence("这是没有触发词的正文。<!-- 休息质量 -->");
  assert.deepEqual(topicEvidence, []);
  assert.deepEqual(validateTopicEvidenceStructure({
    entities: [{ id: laborId, type: "topic" }],
    events: [{ entityIds: [laborId], topicEvidence }],
  }), []);
});

test("topic evidence structure rejects missing, non-topic, duplicate and unlinked references", () => {
  const base = {
    entities: [{ id: laborId, type: "topic" }, { id: "place", type: "place" }],
    events: [{ entityIds: [laborId, "place"], topicEvidence: [{ entityId: laborId, terms: ["工资"] }] }],
  };
  assert.deepEqual(validateTopicEvidenceStructure(base), []);
  const corruptions = [
    (kg) => { delete kg.events[0].topicEvidence; },
    (kg) => { kg.events[0].topicEvidence[0].entityId = "missing"; },
    (kg) => { kg.events[0].topicEvidence[0].entityId = "place"; },
    (kg) => { kg.events[0].entityIds = []; },
    (kg) => { kg.events[0].topicEvidence.push(structuredClone(kg.events[0].topicEvidence[0])); },
    (kg) => { kg.events[0].topicEvidence[0] = null; },
    ...[[], [""], [" "], [3], ["工资", "工资"]].map((terms) => (kg) => { kg.events[0].topicEvidence[0].terms = terms; }),
  ];
  for (const corrupt of corruptions) {
    const invalid = structuredClone(base);
    corrupt(invalid);
    assert.ok(validateTopicEvidenceStructure(invalid).length > 0);
  }
});

test("source validation rejects forged, omitted, sibling and unreviewed topic evidence", async () => {
  const corruptions = [
    (kg) => { kg.events[0].topicEvidence.find((match) => match.entityId === laborId).terms.push("裁员"); },
    (kg) => { kg.events[0].topicEvidence = []; },
    (kg) => { kg.events[2].topicEvidence = structuredClone(kg.events[0].topicEvidence); },
    (kg) => { kg.events[0].newsId = "news-missing"; },
    (kg) => { kg.events[0].sourceIds = ["page-missing"]; },
    (kg) => { kg.entities.find((entity) => entity.id === laborId).aliases.push("排班"); },
    (kg) => { kg.source.extractionVersion = "0.0.0"; },
  ];
  for (const corrupt of corruptions) {
    const invalid = structuredClone(fixture.kg);
    corrupt(invalid);
    const issues = await validateTopicEvidence(invalid, fixture.dataset, rules, fixture.sourceRoot);
    assert.ok(issues.length > 0);
  }
});

test("topic evidence validation and KG building reject changed source bytes", async () => {
  const path = resolve(fixture.sourceRoot, bodyPath);
  await writeFile(path, bodyRaw.replace("涉及排班", "涉及调班"));
  try {
    const issues = await validateTopicEvidence(fixture.kg, fixture.dataset, rules, fixture.sourceRoot);
    assert.ok(issues.some((issue) => /hash mismatch/u.test(issue.message)));
    await assert.rejects(run("scripts/build-kg.mjs", [
      "--source", fixture.sourceRoot,
      "--news", fixture.newsPath,
      "--output", resolve(fixture.directory, "tampered-kg.json"),
    ]), /hash mismatch/u);
  } finally {
    await writeFile(path, bodyRaw);
  }
});

test("topic rules reject the obsolete keyword field and malformed names or triggers", () => {
  const corruptions = [
    (topic) => { topic.keywords = [...topic.extractionTriggers]; },
    (topic) => { delete topic.aliases; },
    (topic) => { delete topic.extractionTriggers; },
    (topic) => { topic.extractionTriggers = []; },
    (topic) => { topic.extractionTriggers = [""]; },
    (topic) => { topic.extractionTriggers = [" GDP "]; },
    (topic) => { topic.extractionTriggers = ["GDP", "GDP"]; },
    (topic) => { topic.aliases = ["同义词", "同义词"]; },
  ];
  for (const corrupt of corruptions) {
    const invalid = structuredClone(rules);
    corrupt(invalid.topics[0]);
    assert.throws(() => assertExtractionRules(invalid));
    assert.throws(() => createExtractionEngine(invalid));
  }
});

test("incremental append preserves accepted evidence and carries new event evidence", () => {
  const existingPage = fixture.kg.sources.find((source) => source.repositoryPath === bodyPath);
  const existing = {
    ...fixture.kg,
    sources: [existingPage],
    events: fixture.kg.events.filter((event) => event.sourceIds[0] === existingPage.id),
  };
  const candidate = structuredClone(fixture.kg);
  candidate.events[0].topicEvidence = [];
  const result = appendNewRecords(existing, candidate, [metadataPath], "2026-10-01T00:00:00Z");
  assert.equal(result.appended.events.length, 2);
  for (const event of existing.events) {
    assert.equal(result.kg.events.find((item) => item.id === event.id), event);
  }
  for (const event of result.appended.events) {
    assert.deepEqual(event.topicEvidence, fixture.kg.events.find((item) => item.id === event.id).topicEvidence);
    assert.ok(event.topicEvidence.length > 0);
  }
  assert.deepEqual(validateTopicEvidenceStructure(result.kg), []);
});

function searchMatches(kg, event, query) {
  const entities = event.entityIds.map((id) => kg.entities.find((entity) => entity.id === id));
  const document = createEventSearchDocument({
    event,
    entities,
    source: kg.sources.find((source) => source.id === event.sourceIds[0]),
    eventType: ontology.eventTypes.find((type) => type.id === event.type),
    entityTypes: entities.map((entity) => ontology.entityTypes.find((type) => type.id === entity.type)),
  });
  return matchesSearchDocument(document, parseSearchQuery(query));
}

async function run(script, args) {
  return execFile(process.execPath, [resolve(root, script), ...args], { cwd: root });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
