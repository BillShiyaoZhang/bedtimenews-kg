import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { parseSourcePage } from "../scripts/lib/news.mjs";
import { buildKnowledgeGraph } from "../scripts/lib/kg-build.mjs";
import { buildCandidateProvenance, validateCandidateProvenance } from "../scripts/lib/candidate-provenance.mjs";
import { buildCandidateLifecycle, validateCandidateLifecycle, summarizeCandidateLifecycleInput } from "../scripts/lib/candidate-lifecycle.mjs";
import { validateActionEvidenceSources } from "../scripts/lib/action-evidence.mjs";
import { actionAssessmentDiff, summarizeActionAssessments } from "../scripts/lib/action-reporting.mjs";
const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const [ontology, rules, template] = await Promise.all(["ontology.json", "extraction-rules.json", "processed/news.json"].map(read));
const generatedAt = "2026-01-01T00:00:00Z";
const bindings = Object.fromEntries(["segmentationHash", "overridesHash", "ontologyHash", "rulesHash", "generatorHash"].map((key) => [key, sha256(key)]));
function fixture(bodies, selectedRules = rules) {
  const dataset = { ...template, generatedAt, pages: [], news: [] }; const rawPages = new Map(); const sourceInventory = {};
  for (const [path, body] of bodies) {
    const raw = `---\ntitle: 独立新闻测试\npublished: true\ndateCreated: ${generatedAt}\n---\n\n## 1. 工程与法律新闻\n\n${body}\n\n这条记录保留新闻来源和完整上下文，供读者逐项核对相关资料。\n`;
    const result = parseSourcePage(path, raw); dataset.pages.push(result.page); dataset.news.push(...result.news); rawPages.set(result.page.id, raw); sourceInventory[path] = sha256(raw);
  }
  const built = buildKnowledgeGraph({ dataset, rawPages, ontology, rules: selectedRules, generatedAt, collectTrace: true });
  const options = { ...built, dataset, rawPages, sourceInventory, ontology, rules: selectedRules, bindings };
  const provenance = buildCandidateProvenance(options);
  return { ...options, news: dataset, provenance };
}
const plan = (value) => ({ observedInventory: value.sourceInventory, effectiveInventory: value.sourceInventory, sourceStates: {}, decisions: [] });
const actionAssertions = (value) => value.provenance.assertions.filter((row) => row.predicate === "assigned_reported_action");

test("same trigger in planned and reported scopes gets exact distinct occurrence witnesses", async () => {
  const value = fixture([["daily/a.md", "甲铁路项目计划明年开工建设。乙铁路项目已经开工建设。"]]);
  const assessment = value.kg.events[0].actionAssessment;
  assert.equal(assessment.status, "applicable"); assert.equal(assessment.assignments.length, 2);
  assert.deepEqual(new Set(assessment.assignments.map((row) => row.modality)), new Set(["planned", "reported"]));
  const occurrences = value.provenance.evidence.filter((row) => row.spanPolicy === "exact_action_occurrence" && row.text === assessment.assignments[0].evidence[0].predicate.text);
  assert.equal(occurrences.length, 2); assert.notEqual(occurrences[0].id, occurrences[1].id); assert.notDeepEqual(occurrences[0].firstRange, occurrences[1].firstRange);
  assert.ok(occurrences.every((row) => row.occurrenceCount === 1));
  assert.equal(value.provenance.actionAssessments.length, value.kg.events.length);
  assert.equal(actionAssertions(value).length, 2);
  assert.deepEqual(validateCandidateProvenance(value.provenance, value), []);
  assert.deepEqual(await validateActionEvidenceSources(value.kg, value.dataset, rules, "/unused", { rawPages: value.rawPages }), []);
});

test("source-backed validator rejects forged qualification, occurrence range and adjacent-news evidence", async () => {
  const value = fixture([["daily/a.md", "甲铁路项目计划明年开工建设。"], ["daily/b.md", "乙市人民法院依法判处被告人张某有期徒刑三年。"]]);
  for (const corrupt of [
    (kg) => { kg.events[0].actionAssessment.assignments[0].modality = "reported"; },
    (kg) => { kg.events[0].actionAssessment.assignments[0].evidence[0].predicate.start += 1; },
    (kg) => { kg.events[0].actionAssessment = structuredClone(kg.events[1].actionAssessment); },
    (kg) => { delete kg.events[0].actionAssessment; },
  ]) {
    const kg = structuredClone(value.kg); corrupt(kg);
    assert.ok((await validateActionEvidenceSources(kg, value.dataset, rules, "/unused", { rawPages: value.rawPages })).length);
  }
  for (const corrupt of [
    (p) => { p.actionAssessments[0].status = "not_applicable"; },
    (p) => { p.evidence.find((row) => row.spanPolicy).firstRange[0] += 1; },
    (p) => { const support = p.supports.find((row) => row.actionAssessmentId); support.actionAssessmentId = p.actionAssessments.find((row) => row.id !== support.actionAssessmentId).id; },
  ]) {
    const provenance = structuredClone(value.provenance); corrupt(provenance);
    assert.ok(validateCandidateProvenance(provenance, value).length);
  }
});

test("qualifier-only correction deactivates the old scoped assignment rather than claiming fact falsity", () => {
  const before = fixture([["daily/a.md", "甲铁路项目计划明年开工建设。"]]);
  const current = fixture([["daily/a.md", "甲铁路项目已经开工建设。"]]);
  assert.equal(before.kg.events[0].id, current.kg.events[0].id);
  const bundleId = sha256("prior-action-bundle");
  const baseline = { ...before, bundleId, lifecycle: buildCandidateLifecycle({ current: before, sourcePlan: plan(before) }) };
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan: plan(current) });
  const previous = actionAssertions(before)[0], next = actionAssertions(current)[0]; assert.notEqual(previous.id, next.id);
  assert.equal(lifecycle.transitions.assertions.find((row) => row.id === previous.id).reason, "last_support_removed");
  assert.equal(lifecycle.states.assertions.find((row) => row.id === previous.id).state, "dormant");
  assert.equal(lifecycle.states.assertions.find((row) => row.id === next.id).state, "active");
  assert.deepEqual(validateCandidateLifecycle(lifecycle, { baseline, current, sourcePlan: plan(current) }), []);
  const diff = actionAssessmentDiff(before.kg, current.kg).actions;
  assert.deepEqual(diff.changedNewsIds, [before.kg.events[0].newsId]);
  assert.equal(diff.records.summary.changed, 1);
});

test("duplicate source text keeps separate news supports and one withdrawal does not remove another", () => {
  const body = "甲铁路项目已经开工建设。";
  const before = fixture([["daily/a.md", body], ["daily/b.md", body]]);
  const current = fixture([["daily/b.md", body]]);
  assert.equal(before.provenance.duplicateContentGroups.length, 1);
  assert.equal(actionAssertions(before).length, 2);
  assert.equal(summarizeActionAssessments(before.kg).directClassNewsCounts["action-engineering"], 2);
  const baseline = { ...before, bundleId: sha256("duplicate-source-parent"), lifecycle: buildCandidateLifecycle({ current: before, sourcePlan: plan(before) }) };
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan: plan(current) });
  const surviving = actionAssertions(current)[0];
  assert.equal(lifecycle.states.assertions.find((row) => row.id === surviving.id).state, "active");
  assert.equal(actionAssertions(before).filter((row) => row.id !== surviving.id).every((row) => lifecycle.states.assertions.find((state) => state.id === row.id).state === "dormant"), true);
  assert.match(summarizeActionAssessments(before.kg).independence, /not_independent_confirmations/u);
});

test("default unknown and old missing assessments are distinct from reviewed not_applicable", () => {
  const value = fixture([["daily/a.md", "居民收入与工资安排仍在讨论。"]]);
  assert.equal(value.kg.events[0].actionAssessment.status, "undetermined");
  assert.equal(actionAssertions(value).length, 0);
  const legacy = structuredClone(value.kg); for (const event of legacy.events) delete event.actionAssessment;
  delete legacy.source.actionExtractionVersion; delete legacy.source.actionNormalizationVersion;
  const report = actionAssessmentDiff(legacy, value.kg).actions;
  assert.equal(report.before.unrecordedLegacyNews, 1); assert.equal(report.before.statusCounts.not_applicable, 0);
  assert.equal(report.after.statusCounts.undetermined, 1);
  assert.equal(canonicalJson(value.provenance).includes('"epistemicScope":"extraction_assignment"'), true);
});


test("frozen lifecycle rejects self-rehashed substitution of legacy classification for action support", () => {
  const value = fixture([["daily/a.md", "甲铁路项目计划明年开工建设。"]]);
  for (const predicate of ["action_applicability", "assigned_reported_action"]) {
    const forged = structuredClone(value.provenance);
    const assertion = forged.assertions.find((row) => row.predicate === predicate);
    const oldSupport = forged.supports.find((row) => row.assertionId === assertion.id);
    const classification = forged.classifications.find((row) => row.eventId === assertion.subject);
    const details = { assertionId: assertion.id, method: "classification", decisionId: classification.id };
    const substitute = { id: `support-${sha256(canonicalJson(details)).slice(0, 24)}`, ...details };
    forged.supports = forged.supports.filter((row) => row.assertionId !== assertion.id).concat(substitute);
    const revision = forged.assertionRevisions.find((row) => row.assertionId === assertion.id);
    revision.supportIds = [substitute.id];
    const { id: ignored, ...revisionData } = revision; void ignored;
    revision.id = `assertion-revision-${sha256(canonicalJson(revisionData)).slice(0, 24)}`;
    assert.notEqual(oldSupport.id, substitute.id);
    assert.throws(() => summarizeCandidateLifecycleInput({ ...value, provenance: forged }), /action assertion requires its own action assessment support/u);
  }
});

test("reviewed not_applicable persists exact review witness without inventing an action assignment", async () => {
  const bodies = [["daily/a.md", "居民工资与排班方式仍在讨论。"]];
  const initial = fixture(bodies); const item = initial.dataset.news[0];
  const raw = initial.rawPages.get(item.pageId);
  const { readNewsFragment } = await import("../scripts/lib/news.mjs");
  const { normalizeActionFragment } = await import("../scripts/lib/action-extraction.mjs");
  const visible = normalizeActionFragment(readNewsFragment(raw, item.fragment));
  const text = "居民工资与排班方式仍在讨论。", start = visible.indexOf(text);
  const selected = structuredClone(rules);
  selected.actionExtraction.reviewedAssessments = [{ id: "review-test-status-only", newsId: item.id, fragmentHash: item.fragment.contentHash, status: "not_applicable", reviewedAt: generatedAt,
    reason: "Fixture reviewer explicitly classifies this exact passage as an explanatory worktime discussion", evidence: { start, end: start + text.length, text } }];
  const reviewed = fixture(bodies, selected);
  assert.equal(reviewed.kg.events[0].actionAssessment.status, "not_applicable");
  assert.equal(actionAssertions(reviewed).length, 0);
  const decision = reviewed.provenance.actionAssessments[0];
  const witness = reviewed.provenance.evidence.find((row) => row.id === decision.review.evidenceId);
  assert.equal(witness.text, text); assert.deepEqual(witness.firstRange, [start, start + text.length]);
  assert.deepEqual(decision.evidenceIds, [witness.id]);
  assert.equal(reviewed.provenance.assertions.find((row) => row.predicate === "action_applicability").object, "not_applicable");
  assert.deepEqual(await validateActionEvidenceSources(reviewed.kg, reviewed.dataset, selected, "/unused", { rawPages: reviewed.rawPages }), []);
  assert.throws(() => fixture([["daily/a.md", `${bodies[0][1]}修改。`]], selected), /fragmentHash is stale/u);
});

test("frozen lifecycle rejects rehashed cross-news action input and witnesses even for identical text", () => {
  const value = fixture([["daily/a.md", "甲铁路项目计划明年开工建设。"], ["daily/b.md", "甲铁路项目计划明年开工建设。"]]);
  for (const borrowInput of [false, true]) {
    const p = structuredClone(value.provenance);
    const [a, b] = p.actionAssessments;
    const oldId = a.id; a.assignments = structuredClone(b.assignments); a.evidenceIds = [...b.evidenceIds];
    if (borrowInput) a.inputId = b.inputId;
    const { id: ignored, ...decision } = a; void ignored;
    a.id = `action-assessment-${sha256(canonicalJson(decision)).slice(0, 24)}`;
    for (const support of p.supports.filter((row) => row.actionAssessmentId === oldId)) {
      const oldSupportId = support.id; support.actionAssessmentId = a.id;
      if (support.method === "fragment_action_rule") {
        const match = a.assignments[0].evidence[0];
        support.evidenceIds = [...new Set([match.predicateEvidenceId, match.scopeEvidenceId, ...match.qualifiers.map((q) => q.evidenceId)])].sort();
      }
      const { id: ignoredSupport, ...details } = support; void ignoredSupport;
      support.id = `support-${sha256(canonicalJson(details)).slice(0, 24)}`;
      const revision = p.assertionRevisions.find((row) => row.assertionId === support.assertionId);
      revision.supportIds = revision.supportIds.map((id) => id === oldSupportId ? support.id : id).sort();
      const { id: ignoredRevision, ...record } = revision; void ignoredRevision;
      revision.id = `assertion-revision-${sha256(canonicalJson(record)).slice(0, 24)}`;
    }
    assert.throws(() => summarizeCandidateLifecycleInput({ ...value, provenance: p }), /cross-news or invalid action (input|witness)/u);
  }
});
