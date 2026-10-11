import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileOntology, compileOntologyFiles, assertAcceptedCompilation } from "../scripts/lib/ontology-compiler.mjs";
import { createExtractionEngine, materializeEntity } from "../scripts/lib/extraction.mjs";
import { assertActionExtractionConfig } from "../scripts/lib/extraction-rules.mjs";
import { eventMatchesTopic, hierarchyIndex, topicEntityIds, topicMatchReason, validateCompiledHierarchy } from "../app/lib/ontology-hierarchy.mjs";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));
const read = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const [source, patterns, kg, state] = await Promise.all([read("data/ontology-source.json"), read("data/extraction-patterns.json"), read("data/generated/kg.json"), read("data/archive-state.json")]);
const { ontology, rules } = compileOntology(source, patterns);
const expectedTopicDomains = {
  "economy-industry": ["macroeconomy", "public-finance", "finance", "manufacturing", "digital-economy", "agriculture", "consumption"],
  "science-technology": ["science", "ai", "semiconductor"],
  "resources-environment-infrastructure": ["energy", "environment", "transport"],
  "livelihood-public-services": ["labor", "housing", "population", "social-security", "healthcare", "public-health"],
  "governance-law": ["governance", "law"],
  "international-security": ["international", "defense"],
  "education-culture-sports": ["education", "culture", "sports"],
  "risk-public-safety": ["public-safety"],
};

test("compiler is deterministic and committed artifacts are current", async () => {
  assert.deepEqual(compileOntology(source, patterns), compileOntology(structuredClone(source), structuredClone(patterns)));
  assert.deepEqual(await compileOntologyFiles(root), { ontology, rules });
  assert.deepEqual(validateCompiledHierarchy(ontology), []);
});

test("eight reviewed topic domains map all 27 existing leaves and pinned KG identities", () => {
  assert.equal(ontology.mappings.topics.length, 27);
  assert.equal(ontology.hierarchies.topic.nodes.filter((node) => node.parentIds.includes("topics")).length, 8);
  for (const [domain, leaves] of Object.entries(expectedTopicDomains)) {
    assert.deepEqual(ontology.hierarchies.topic.descendants[`topic-domain-${domain}`], leaves.map((id) => `topic-${id}`).sort());
  }
  for (const topic of rules.topics) {
    const entity = kg.entities.find((entity) => entity.id === topic.entityId);
    assert.equal(entity.label, topic.label);
    assert.equal(entity.type, "topic");
    assert.deepEqual(entity.aliases, topic.aliases);
  }
  assert.deepEqual(ontology.entityTypes.map((type) => type.id), ["person", "organization", "place", "facility", "policy", "document", "topic"]);
  assert.equal(ontology.eventTypes.length, 13);
  for (const type of ["policy", "document"]) assert.equal(ontology.mappings.entityTypes.find((mapping) => mapping.legacyId === type).conceptId, "class-information-resource");
});

test("legacy domains stay distinct from action definitions and evidence", () => {
  const actionIds = new Set(ontology.hierarchies.action.nodes.map((node) => node.id));
  assert.ok(ontology.eventTypes.every((type) => !actionIds.has(type.id)));
  assert.equal(ontology.semantics.actionAssignments, "news_scoped_evidence_backed_reported_descriptions");
  assert.equal(ontology.semantics.actionVerification, "never_verified_real_world_occurrences");
  assert.equal(ontology.hierarchies.entity.relation, "subClassOf");
  assert.equal(ontology.hierarchies.topic.relation, "broaderTopic");
  assert.ok(kg.events.every((event) => !Object.hasOwn(event, "actionIds")));
  assert.ok(kg.entityRelations.every((relation) => !["subClassOf", "broaderTopic", "instanceOf"].includes(relation.type)));
});

test("reference 658 migration adds only its reviewed health phrase to the frozen legacy surfaces", () => {
  const legacyPatterns = structuredClone(Object.fromEntries(Object.entries(patterns).filter(
    ([key]) => !["version", "description", "actionExtraction", "reportingFormReviews", "numericExtraction"].includes(key),
  )));
  const healthcare = legacyPatterns.topics.find((topic) => topic.conceptId === "topic-healthcare");
  assert.equal(healthcare.extractionTriggers.pop(), "食用银鳕鱼导致汞超标");
  const legacy = {
    entityTypes: source.legacyEntityTypes,
    eventDomains: source.legacyEventDomains,
    mappings: source.mappings,
    entityNodes: source.hierarchies.entity.nodes,
    topicNodes: source.hierarchies.topic.nodes,
    patterns: legacyPatterns,
  };
  assert.equal(createHash("sha256").update(JSON.stringify(legacy)).digest("hex"), "ac1614a487232ae09c8056884272760b224229643ccfa3d5ae53ac2914dea587");
  assert.equal(ontology.version, "2.5.0");
  assert.equal(rules.version, "4.3.1");
  assert.equal(ontology.compilation.compilerVersion, "1.2.0");
  assert.equal(ontology.compilation.formatVersion, 1);
});

test("only supported concrete actions and their abstract ancestors are active", () => {
  const active = ontology.hierarchies.action.nodes.filter((node) => node.status === "active");
  assert.deepEqual(active.filter((node) => node.abstract).map((node) => node.id).sort(), ["action", "occurrence", "state-change"]);
  assert.deepEqual(active.filter((node) => !node.abstract).map((node) => node.id).sort(), ["action-engineering", "action-legal", "change-quantitative"]);
  assert.ok(ontology.hierarchies.action.nodes.filter((node) => !active.includes(node)).every((node) => node.status === "draft"));
  for (const node of active.filter((node) => !node.abstract)) {
    assert.ok(node.description.includes("排除"), `${node.id} has an explicit exclusion boundary`);
    assert.ok(node.description.length > 100, `${node.id} has a substantive inclusion definition`);
    assert.ok(rules.actionExtraction.rules.some((rule) => rule.conceptId === node.id));
  }
  for (const [id, field, value] of [["action-legal", "abstract", true], ["action-legal", "status", "draft"], ["action-transaction", "status", "active"], ["action", "abstract", false]]) {
    const changed = structuredClone(source);
    changed.hierarchies.action.nodes.find((node) => node.id === id)[field] = value;
    assert.throws(() => compileOntology(changed, patterns));
  }
});

test("action assessment vocabularies and definitions have one authored semantic source", () => {
  assert.equal(ontology.actionAssessment.schemaVersion, 1);
  assert.equal(ontology.actionAssessment.normalizationVersion, rules.actionExtraction.normalizationVersion);
  assert.deepEqual(ontology.actionAssessment.statuses.map((entry) => entry.id), ["applicable", "not_applicable", "undetermined"]);
  assert.deepEqual(ontology.actionAssessment.polarities.map((entry) => entry.id), ["affirmative", "negated", "undetermined"]);
  assert.deepEqual(ontology.actionAssessment.modalities.map((entry) => entry.id), ["reported", "planned", "predicted", "conditional", "undetermined"]);
  const changed = structuredClone(source);
  changed.hierarchies.action.nodes.find((node) => node.id === "action-legal").label = "法律行动（名称变更测试）";
  changed.actionAssessment.statuses[0].label = "有文本依据（名称变更测试）";
  const next = compileOntology(changed, patterns);
  assert.deepEqual(next.rules.actionExtraction, rules.actionExtraction);
  assert.notEqual(next.ontology.compilation.sourceHash, ontology.compilation.sourceHash);
  assert.equal(next.ontology.actionAssessment.statuses[0].label, changed.actionAssessment.statuses[0].label);
  for (const mutate of [
    (value) => { delete value.actionAssessment; },
    (value) => { value.actionAssessment.schemaVersion = 2; },
    (value) => { value.actionAssessment.normalizationVersion = "unknown"; },
    (value) => { value.actionAssessment.statuses.pop(); },
    (value) => { value.actionAssessment.statuses[0].id = "verified"; },
    (value) => { value.actionAssessment.polarities[0].label = ""; },
    (value) => { value.actionAssessment.modalities[0].display = "redundant"; },
    (value) => { value.actionAssessment.reasonCodes[0].description = ""; },
    (value) => { value.actionAssessment.templates[0].conceptId = "class-person"; },
    (value) => { value.semantics.actionAssignments = "verified_occurrences"; },
    (value) => { value.semantics.legacyEventTypes = "actions"; },
  ]) {
    const invalid = structuredClone(source);
    mutate(invalid);
    assert.throws(() => compileOntology(invalid, patterns));
  }
});

test("compiler fails closed for unknown, duplicate, malformed or unsupported action rules", () => {
  for (const mutate of [
    (value) => { delete value.actionExtraction; },
    (value) => { value.actionExtraction = []; },
    (value) => { value.actionExtraction.version = "next"; },
    (value) => { value.actionExtraction.normalizationVersion = "raw"; },
    (value) => { value.actionExtraction.rules = []; },
    (value) => { value.actionExtraction.rules[0] = null; },
    (value) => { value.actionExtraction.rules[0].label = "法律行动"; },
    (value) => { value.actionExtraction.rules[0].pattern = ".*"; },
    (value) => { value.actionExtraction.rules[0].template = "unknown"; },
    (value) => { value.actionExtraction.rules[0].conceptId = "missing"; },
    (value) => { value.actionExtraction.rules[0].conceptId = "topic-labor"; },
    (value) => { value.actionExtraction.rules[0].conceptId = "class-person"; },
    (value) => { value.actionExtraction.rules[0].conceptId = "action"; },
    (value) => { value.actionExtraction.rules[0].conceptId = "action-research"; },
    (value) => { value.actionExtraction.rules[0].conceptId = "action-engineering"; },
    (value) => { value.actionExtraction.rules[0].predicates = "判处"; },
    (value) => { value.actionExtraction.rules[0].predicates = []; },
    (value) => { value.actionExtraction.rules[0].predicates = ["判处", "判处"]; },
    (value) => { value.actionExtraction.rules[0].contextTerms = [""]; },
    (value) => { value.actionExtraction.rules[0].exclusions = [null]; },
    (value) => { value.actionExtraction.rules[0].exclusions = [" 判决书 "]; },
    (value) => { value.actionExtraction.rules[1].id = value.actionExtraction.rules[0].id; },
    (value) => { value.actionExtraction.rules.push({ ...structuredClone(value.actionExtraction.rules[0]), id: "duplicate-new-id" }); },
    (value) => { value.actionExtraction.qualifierCues[0].id = value.actionExtraction.rules[0].id; },
    (value) => { value.actionExtraction.qualifierCues[0].kind = "certainty"; },
    (value) => { value.actionExtraction.qualifierCues[0].value = "affirmative"; },
    (value) => { value.actionExtraction.qualifierCues[2].value = "verified"; },
    (value) => { value.actionExtraction.qualifierCues[0].terms = ["未", "未"]; },
    (value) => { value.actionExtraction.qualifierCues[1].terms.push(value.actionExtraction.qualifierCues[0].terms[0]); },
    (value) => { value.actionExtraction.qualifierCues.push({ ...structuredClone(value.actionExtraction.qualifierCues[0]), id: "duplicate-cue-new-id" }); },
    (value) => { value.actionExtraction.reviewedAssessments = {}; },
    (value) => { value.actionExtraction.statusLabels = {}; },
    (value) => { value.unknownRules = []; },
    (value) => { value.eventClassification[0].label = "semantic redefinition"; },
  ]) {
    const invalid = structuredClone(patterns);
    mutate(invalid);
    assert.throws(() => compileOntology(source, invalid));
  }
});

test("not_applicable requires an explicit structurally valid reviewed news/hash/span anchor", () => {
  const evidenceText = "这是一段静态指标说明";
  const review = { id: "review-static-observation-v1", newsId: "news-123456abcdef", fragmentHash: "a".repeat(64), status: "not_applicable", reviewedAt: "2026-09-30T00:00:00Z", reason: "人工核对静态观察，不含受支持的行动或变化。", evidence: { start: 2, end: 2 + evidenceText.length, text: evidenceText } };
  const changed = structuredClone(patterns);
  changed.actionExtraction.reviewedAssessments = [review];
  assert.deepEqual(compileOntology(source, changed).rules.actionExtraction.reviewedAssessments, [review]);
  for (const mutate of [
    (value) => { delete value.newsId; },
    (value) => { value.newsId = ""; },
    (value) => { value.newsId = "page-123456abcdef"; },
    (value) => { value.fragmentHash = "a".repeat(63); },
    (value) => { value.status = "undetermined"; },
    (value) => { value.reviewedAt = "2026-02-30T00:00:00Z"; },
    (value) => { value.reviewedAt = "2026-09-30"; },
    (value) => { value.reason = " "; },
    (value) => { value.evidence.start = -1; },
    (value) => { value.evidence.end -= 1; },
    (value) => { value.evidence.text = ""; },
    (value) => { value.evidence.start = 0.5; },
    (value) => { value.evidence.offsetUnit = "bytes"; },
    (value) => { value.matchAbsent = true; },
    (value) => { value.id = changed.actionExtraction.rules[0].id; },
  ]) {
    const invalid = structuredClone(changed);
    mutate(invalid.actionExtraction.reviewedAssessments[0]);
    assert.throws(() => compileOntology(source, invalid));
  }
  const duplicate = structuredClone(changed);
  duplicate.actionExtraction.reviewedAssessments.push({ ...review, id: "different-review-same-news" });
  assert.throws(() => compileOntology(source, duplicate), /news identity/u);
  assert.throws(() => assertActionExtractionConfig({ ...changed.actionExtraction, schema: "unreviewed" }));
});

test("compiler rejects malformed hierarchy, kind, status and unknown references", () => {
  const corruptions = [
    (value) => value.hierarchies.topic.nodes.push(structuredClone(value.hierarchies.topic.nodes[1])),
    (value) => { value.hierarchies.topic.nodes[1].parentIds = ["missing"]; },
    (value) => { value.hierarchies.topic.nodes[1].parentIds = ["class-entity"]; },
    (value) => { value.hierarchies.topic.nodes[1].parentIds = []; },
    (value) => { value.hierarchies.topic.nodes[1].parentIds = {}; },
    (value) => { value.hierarchies.topic.nodes[1].primaryParentId = "missing"; },
    (value) => { value.hierarchies.topic.nodes[1].parentIds = [value.hierarchies.topic.nodes[1].id]; },
    (value) => { value.hierarchies.topic.nodes[0].parentIds = [value.hierarchies.topic.nodes[1].id]; },
    (value) => { value.hierarchies.topic.relation = "partOf"; },
    (value) => { value.hierarchies.topic.nodes.find((node) => node.id === "topic-labor").status = "draft"; },
    (value) => { value.mappings.topics[0].conceptId = "class-person"; },
    (value) => { value.mappings.topics[0].entityId = value.mappings.topics[1].entityId; },
    (value) => { value.mappings.topics.pop(); },
    (value) => { value.mappings.entityTypes.pop(); },
    (value) => { value.mappings.entityTypes.find((mapping) => mapping.legacyId === "policy").conceptId = "class-normative-document"; },
    (value) => { value.relationTypes[0].to = ["unknown"]; },
    (value) => { value.facets[0].eventTypes = ["unknown"]; },
    (value) => { value.version = "latest"; },
    (value) => { value.unknownRegistry = []; },
  ];
  for (const corrupt of corruptions) {
    const invalid = structuredClone(source);
    corrupt(invalid);
    assert.throws(() => compileOntology(invalid, patterns));
  }
});

test("compiler rejects rules redefining names, unknown concepts and invalid domains", () => {
  for (const mutate of [
    (value) => { value.topics[0].label = "手写名称"; },
    (value) => { value.topics[0].conceptId = "missing"; },
    (value) => { value.topics[0].conceptId = value.topics[1].conceptId; },
    (value) => { value.topics[0].legacyEventType = "action-transaction"; },
    (value) => { value.eventClassification[0].id = "missing"; },
    (value) => { value.topics.pop(); },
  ]) {
    const invalid = structuredClone(patterns);
    mutate(invalid);
    assert.throws(() => compileOntology(source, invalid));
  }
});

test("topic renaming preserves stable entity identity and evidence references", () => {
  const renamed = structuredClone(source);
  const node = renamed.hierarchies.topic.nodes.find((node) => node.id === "topic-labor");
  node.label = "劳动与就业（测试名称）";
  const next = compileOntology(renamed, patterns);
  const engine = createExtractionEngine(next.rules);
  const candidate = engine.extractCandidates("工资和排班").find((candidate) => candidate.label === node.label);
  const expectedId = rules.topics.find((topic) => topic.id === "topic-labor").entityId;
  assert.equal(candidate.key, "topic:topic-labor");
  assert.equal(materializeEntity({ ...candidate, eventCount: 1 }).id, expectedId);
  assert.ok(engine.matchTopicEvidence("工资和排班").some((match) => match.entityId === expectedId));
});

test("reviewed topic links use the same pinned identity and deduplicate trigger candidates", () => {
  const changed = structuredClone(patterns);
  changed.reviewedNewsEntityLinks = { sample: [{ type: "topic", conceptId: "topic-labor" }] };
  const nextSource = structuredClone(source);
  nextSource.hierarchies.topic.nodes.find((node) => node.id === "topic-labor").label = "劳动新名称";
  const { rules: nextRules } = compileOntology(nextSource, changed);
  const engine = createExtractionEngine(nextRules);
  const candidates = engine.extractCandidates("工资", "", { newsId: "sample" }).filter((candidate) => candidate.type === "topic" && candidate.label === "劳动新名称");
  assert.equal(candidates.length, 1);
  const expected = rules.topics.find((topic) => topic.id === "topic-labor").entityId;
  assert.equal(materializeEntity({ ...candidates[0], eventCount: 1 }).id, expected);
  const reviewedOnly = engine.extractCandidates("无触发词", "", { newsId: "sample" }).find((candidate) => candidate.type === "topic");
  assert.equal(materializeEntity({ ...reviewedOnly, eventCount: 1 }).id, expected);
  const invalid = structuredClone(changed);
  invalid.reviewedNewsEntityLinks.sample[0] = { type: "topic", label: "就业与劳动" };
  assert.throws(() => compileOntology(source, invalid), /conceptId/u);
});

test("parent topic navigation includes descendants, excludes siblings and explains matches", () => {
  const labor = rules.topics.find((topic) => topic.id === "topic-labor").entityId;
  const ai = rules.topics.find((topic) => topic.id === "topic-ai").entityId;
  const event = { entityIds: [labor] };
  assert.equal(eventMatchesTopic(ontology, event, "topic-domain-livelihood-public-services"), true);
  assert.equal(eventMatchesTopic(ontology, event, "topic-domain-science-technology"), false);
  assert.equal(eventMatchesTopic(ontology, event, "topic-labor"), true);
  assert.equal(topicMatchReason(ontology, event, "topic-labor")[0].inherited, false);
  assert.equal(topicMatchReason(ontology, event, "topic-domain-livelihood-public-services")[0].inherited, true);
  assert.equal(eventMatchesTopic(ontology, { entityIds: [ai] }, "topic-domain-science-technology"), true);
  assert.throws(() => topicEntityIds(ontology, "unknown"));
});

test("diamond broaderTopic expansion deduplicates news and uses primary navigation", () => {
  const diamond = structuredClone(source);
  const ai = diamond.hierarchies.topic.nodes.find((node) => node.id === "topic-ai");
  ai.parentIds.push("topic-domain-economy-industry");
  const { ontology: view } = compileOntology(diamond, patterns);
  const aiId = topicEntityIds(view, "topic-ai")[0];
  const events = [{ entityIds: [aiId] }];
  assert.equal(events.filter((event) => eventMatchesTopic(view, event, "topics")).length, 1);
  assert.equal(topicEntityIds(view, "topics").filter((id) => id === aiId).length, 1);
  assert.equal(ai.primaryParentId, "topic-domain-science-technology");
  assert.deepEqual(hierarchyIndex(view.hierarchies.topic).ancestors[ai.id], ["topic-domain-economy-industry", "topic-domain-science-technology", "topics"]);
});

test("shared runtime validation rejects tampered closures and mappings", () => {
  const invalid = structuredClone(ontology);
  invalid.hierarchies.topic.descendants.topics.pop();
  assert.ok(validateCompiledHierarchy(invalid).length);
  const unmapped = structuredClone(ontology);
  unmapped.mappings.topics.pop();
  assert.ok(validateCompiledHierarchy(unmapped).length);
  const inactive = structuredClone(ontology);
  inactive.mappings.entityTypes.find((mapping) => mapping.legacyId === "policy").conceptId = "class-normative-document";
  assert.ok(validateCompiledHierarchy(inactive).length);
});

test("runtime hierarchy validation keeps historical compiler receipts readable", () => {
  const historical = structuredClone(ontology);
  historical.compilation.compilerVersion = "1.0.0";
  delete historical.actionAssessment;
  for (const node of historical.hierarchies.action.nodes) node.status = "draft";
  historical.semantics.actionAssignments = "not_materialized";
  assert.deepEqual(validateCompiledHierarchy(historical), []);
  const unsupported = structuredClone(ontology);
  unsupported.compilation.compilerVersion = "2.0.0";
  assert.ok(validateCompiledHierarchy(unsupported).some((issue) => issue.path === "compilation"));
});

test("accepted provenance rejects same-version edits and missing fingerprints", () => {
  assert.doesNotThrow(() => assertAcceptedCompilation(kg, state, ontology.compilation));
  const altered = structuredClone(patterns);
  altered.topics[0].extractionTriggers.push("新的受控信号");
  const next = compileOntology(source, altered);
  assert.equal(next.rules.version, rules.version);
  assert.throws(() => assertAcceptedCompilation(kg, state, next.ontology.compilation), /fingerprints differ/u);
  assert.throws(() => assertAcceptedCompilation({ source: {} }, state, ontology.compilation));
  assert.throws(() => assertAcceptedCompilation(kg, {}, ontology.compilation));
});

test("check-only compilation detects hand edits and never rewrites files", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "ontology-check-"));
  try {
    await mkdir(resolve(directory, "data"));
    for (const file of ["ontology-source.json", "extraction-patterns.json", "ontology.json", "extraction-rules.json"]) await cp(resolve(root, "data", file), resolve(directory, "data", file));
    for (const file of ["ontology.json", "extraction-rules.json"]) {
      const path = resolve(directory, "data", file);
      const original = await readFile(path, "utf8");
      await writeFile(path, `${original} `);
      await assert.rejects(compileOntologyFiles(directory), /stale or hand-edited/u);
      assert.equal(await readFile(path, "utf8"), `${original} `);
      await writeFile(path, original);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real updater rejects same-version rule changes without touching accepted data", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "ontology-update-"));
  try {
    await cp(resolve(root, "scripts"), resolve(directory, "scripts"), { recursive: true });
    await cp(resolve(root, "app/lib"), resolve(directory, "app/lib"), { recursive: true });
    await mkdir(resolve(directory, "data"));
    for (const file of ["ontology-source.json", "extraction-patterns.json", "ontology.json", "extraction-rules.json", "news-overrides.json"]) await cp(resolve(root, "data", file), resolve(directory, "data", file));
    const archive = resolve(directory, "archive");
    await mkdir(resolve(archive, "daily"), { recursive: true });
    await writeFile(resolve(archive, "daily/test.md"), "---\ntitle: 工资与就业情况\npublished: true\ndateCreated: 2026-09-30T00:00:00Z\n---\n\n## 1、北京市工资上涨\n\n北京市公布工资与就业情况，介绍劳动和社会保障的最新数据。\n");
    const run = (cmd, args, cwd = directory) => execFile(cmd, args, { cwd, maxBuffer: 1024 * 1024 });
    await run("git", ["init", "-q"], archive);
    await run("git", ["add", "."], archive);
    await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], archive);
    await run(process.execPath, ["scripts/update-kg.mjs", "--bootstrap", "--source", archive, "--include", "daily"]);
    const paths = ["data/generated/kg.json", "data/processed/news.json", "data/archive-state.json"];
    const before = await Promise.all(paths.map((path) => readFile(resolve(directory, path), "utf8")));
    const changed = structuredClone(patterns);
    changed.topics[0].extractionTriggers.push("fixture新信号");
    await writeFile(resolve(directory, "data/extraction-patterns.json"), JSON.stringify(changed));
    await compileOntologyFiles(directory, { write: true });
    await assert.rejects(run(process.execPath, ["scripts/update-kg.mjs", "--source", archive, "--include", "daily"]), /fingerprints differ/u);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(resolve(directory, path), "utf8"))), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
