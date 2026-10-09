import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { parseSourcePage, readNewsFragment } from "../scripts/lib/news.mjs";
import { buildKnowledgeGraph } from "../scripts/lib/kg-build.mjs";
import { buildCandidateProvenance, validateCandidateProvenance } from "../scripts/lib/candidate-provenance.mjs";
import { buildCandidateLifecycle, summarizeCandidateLifecycleInput, validateCandidateLifecycle } from "../scripts/lib/candidate-lifecycle.mjs";
import { normalizeActionFragment } from "../scripts/lib/action-extraction.mjs";
import { validateReportDescriptionEvidenceSources } from "../scripts/lib/report-description-evidence.mjs";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const [ontology, rules] = await Promise.all(["ontology.json", "extraction-rules.json"].map(read));
const generatedAt = "2026-01-01T00:00:00Z";
const bindings = Object.fromEntries(["segmentationHash", "overridesHash", "ontologyHash", "rulesHash", "generatorHash"].map((name) => [name, sha256(name)]));
const reportPredicates = new Set(["reporting_form_applicability", "assigned_reporting_form", "numeric_observation_applicability", "reported_numeric_description"]);
const hash = (value) => sha256(canonicalJson(value));
const identity = (prefix, value) => `${prefix}-${hash(value).slice(0, 24)}`;

function fixture(bodies = [["daily/a.md", "工业增加值同比增长5.2%。"]], selectedRules = rules, selectedOntology = ontology) {
  const dataset = { schemaVersion: "1.1.0", generatedAt, segmentation: { version: "1.4.0", overrideVersion: "1.1.0" }, pages: [], news: [] };
  const rawPages = new Map(); const sourceInventory = {};
  for (const [path, body] of bodies) {
    const raw = `---\ntitle: 独立新闻测试\npublished: true\ndateCreated: ${generatedAt}\n---\n\n## 1. 正文证据测试\n\n${body}\n\n这条记录保留新闻来源和完整上下文，供读者逐项核对相关资料。\n`;
    const result = parseSourcePage(path, raw);
    dataset.pages.push(result.page); dataset.news.push(...result.news);
    rawPages.set(result.page.id, raw); sourceInventory[path] = sha256(raw);
  }
  const built = buildKnowledgeGraph({ dataset, rawPages, ontology: selectedOntology, rules: selectedRules, generatedAt, collectTrace: true });
  const options = { ...built, dataset, rawPages, sourceInventory, ontology: selectedOntology, rules: selectedRules, bindings };
  return { ...options, news: dataset, provenance: buildCandidateProvenance(options) };
}
const plan = (value, changes = {}) => ({ observedInventory: value.sourceInventory, effectiveInventory: value.sourceInventory, sourceStates: {}, decisions: [], ...changes });
const first = (value) => ({ ...value, bundleId: sha256("report-description-parent"), lifecycle: buildCandidateLifecycle({ current: value, sourcePlan: plan(value) }) });
const descriptions = (value) => value.provenance.assertions.filter((item) => item.predicate === "reported_numeric_description");
function reviewFor(value, { status = "applicable", concepts = ["reporting-form-analysis", "reporting-form-commentary"] } = {}) {
  const item = value.dataset.news[0];
  const visible = normalizeActionFragment(readNewsFragment(value.rawPages.get(item.pageId), item.fragment));
  const evidence = (text) => ({ normalizationVersion: "visible-fragment-v1", start: visible.indexOf(text), end: visible.indexOf(text) + text.length, text });
  const text = "这条记录保留新闻来源和完整上下文，供读者逐项核对相关资料。";
  return { id: "review-synthetic-report-form", newsId: item.id, fragmentHash: item.fragment.contentHash, status, reviewedAt: generatedAt, reason: "Synthetic fixture review, not a corpus annotation",
    evidence: [evidence(text)], assignments: status === "applicable" ? concepts.map((conceptId, index) => ({ conceptId, evidence: [evidence(index ? "完整上下文" : "新闻来源")] })) : [] };
}
function rehashSupport(provenance, support, patch) {
  const oldId = support.id; Object.assign(support, patch);
  const { id: ignored, ...basis } = support; void ignored;
  support.id = identity("support", basis);
  for (const revision of provenance.assertionRevisions) if (revision.supportIds.includes(oldId)) {
    revision.supportIds = revision.supportIds.map((id) => id === oldId ? support.id : id).sort();
    const { id: unused, ...record } = revision; void unused;
    revision.id = identity("assertion-revision", record);
  }
}

test("new axes have explicit independent decision supports, exact numeric occurrences and unchanged entity observations", async () => {
  const value = fixture([["daily/a.md", "工业增加值同比增长5.2%。工业增加值同比增长5.2%。营业收入环比下降3%。"]]);
  const event = value.kg.events[0];
  assert.equal(event.reportingFormAssessment.status, "undetermined");
  assert.equal(event.numericObservationAssessment.observations.length, 3);
  assert.equal(value.provenance.reportingFormAssessments.length, 1);
  assert.equal(value.provenance.numericObservationAssessments.length, 1);
  assert.equal(value.provenance.reportedNumericObservations.length, 3);
  assert.ok(value.provenance.observations.every((item) => item.entityId && !item.id.startsWith("reported-numeric-observation-")));
  const equalText = value.provenance.evidence.filter((item) => item.spanPolicy === "exact_report_description_occurrence" && item.text === "5.2");
  assert.equal(equalText.length, 2); assert.notEqual(equalText[0].id, equalText[1].id);
  assert.notDeepEqual(equalText[0].firstRange, equalText[1].firstRange);
  assert.ok(equalText.every((item) => item.occurrenceCount === 1));
  assert.equal(value.provenance.assertions.filter((item) => reportPredicates.has(item.predicate)).length, 5);
  assert.deepEqual(validateCandidateProvenance(value.provenance, value), []);
  assert.deepEqual(await validateReportDescriptionEvidenceSources(value.kg, value.dataset, value.ontology, value.rules, "/unused", { rawPages: value.rawPages }), []);
  assert.doesNotThrow(() => summarizeCandidateLifecycleInput(value));
});

test("explicit unknown decisions remain supported without inventing observations or reviewed labels", () => {
  const value = fixture([["daily/a.md", "居民收入与工资安排仍在讨论。"]]);
  assert.equal(value.provenance.reportingFormAssessments[0].status, "undetermined");
  assert.equal(value.provenance.numericObservationAssessments[0].status, "undetermined");
  assert.deepEqual(value.provenance.reportedNumericObservations, []);
  const assertions = value.provenance.assertions.filter((item) => reportPredicates.has(item.predicate));
  assert.equal(assertions.length, 2);
  for (const assertion of assertions) assert.equal(value.provenance.supports.filter((item) => item.assertionId === assertion.id).length, 1);
  assert.deepEqual(validateCandidateProvenance(value.provenance, value), []);
});

test("reviewed multi-label form uses separate decision evidence and exact independent label evidence", () => {
  const bodies = [["daily/a.md", "工业增加值同比增长5.2%。"]];
  const initial = fixture(bodies); const selected = structuredClone(rules);
  selected.reportingFormReviews = [reviewFor(initial)];
  const value = fixture(bodies, selected); const decision = value.provenance.reportingFormAssessments[0];
  assert.equal(decision.status, "applicable"); assert.equal(decision.assignments.length, 2);
  assert.ok(decision.review.evidenceIds.every((id) => !decision.assignments.some((assignment) => assignment.evidenceIds.includes(id))));
  assert.equal(value.provenance.assertions.filter((item) => item.predicate === "assigned_reporting_form").length, 2);
  assert.deepEqual(value.kg.events[0].numericObservationAssessment, initial.kg.events[0].numericObservationAssessment);
  assert.deepEqual(validateCandidateProvenance(value.provenance, value), []);
  assert.doesNotThrow(() => summarizeCandidateLifecycleInput(value));
  assert.throws(() => fixture([["daily/a.md", "工业增加值同比增长5.3%。"]], selected), /stale review/u);
});

test("reviewed not-applicable and reviewed undetermined preserve decision evidence without form assignments", () => {
  for (const status of ["not_applicable", "undetermined"]) {
    const initial = fixture(); const selected = structuredClone(rules);
    selected.reportingFormReviews = [reviewFor(initial, { status })];
    const value = fixture(undefined, selected); const decision = value.provenance.reportingFormAssessments[0];
    assert.equal(decision.status, status); assert.deepEqual(decision.assignments, []);
    assert.equal(decision.review.evidenceIds.length, 1);
    assert.equal(value.provenance.assertions.some((item) => item.predicate === "assigned_reporting_form"), false);
    assert.deepEqual(validateCandidateProvenance(value.provenance, value), []);
    assert.doesNotThrow(() => summarizeCandidateLifecycleInput(value));
  }
});

test("duplicate rules add separate supports while keeping exact numeric observation identities unchanged", () => {
  const original = fixture(); const selected = structuredClone(rules);
  selected.numericExtraction.rules.push({ ...selected.numericExtraction.rules[0], id: "relative-percent-second-support-v1" });
  const duplicated = fixture(undefined, selected);
  assert.deepEqual(duplicated.provenance.reportedNumericObservations, original.provenance.reportedNumericObservations);
  assert.deepEqual(descriptions(duplicated), descriptions(original));
  const assertion = descriptions(duplicated)[0];
  assert.equal(duplicated.provenance.supports.filter((item) => item.assertionId === assertion.id).length, 2);
  const lifecycle = buildCandidateLifecycle({ baseline: first(duplicated), current: original, sourcePlan: plan(original) });
  assert.equal(lifecycle.states.assertions.find((item) => item.id === assertion.id).state, "active");
  assert.equal(lifecycle.transitions.assertions.find((item) => item.id === assertion.id).supportChanges.currentCount, 1);
  assert.deepEqual(validateCandidateProvenance(duplicated.provenance, duplicated), []);
});

test("partial coverage is a compact replayed diagnostic without rejected source copies", () => {
  const value = fixture([["daily/a.md", "工业增加值同比增长5.2%。营业收入为3%。"]]);
  const decision = value.provenance.numericObservationAssessments[0];
  assert.equal(decision.status, "applicable");
  assert.deepEqual(decision.diagnostics, { partialCoverage: true, rejectedCandidateCount: 1, supportedObservationCount: 1 });
  assert.ok(!canonicalJson(decision).includes("营业收入为3%"));
  const corrupt = structuredClone(value.provenance); corrupt.numericObservationAssessments[0].diagnostics.rejectedCandidateCount = 2;
  assert.ok(validateCandidateProvenance(corrupt, value).length);
});

test("source correction withdraws the old numeric occurrence and exact restoration reactivates identical IDs", () => {
  const before = fixture(); const baseline = first(before);
  const current = fixture([["daily/a.md", "工业增加值同比增长5.3%。"]]);
  const previous = descriptions(before)[0]; const next = descriptions(current)[0];
  assert.notEqual(previous.id, next.id); assert.equal(before.kg.events[0].id, current.kg.events[0].id);
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan: plan(current) });
  assert.equal(lifecycle.states.assertions.find((item) => item.id === previous.id).state, "dormant");
  assert.equal(lifecycle.states.assertions.find((item) => item.id === next.id).state, "active");
  assert.equal(lifecycle.transitions.assertions.find((item) => item.id === previous.id).reason, "last_support_removed");
  const restored = fixture();
  const restoration = buildCandidateLifecycle({ baseline: { ...current, bundleId: sha256("numeric-correction"), lifecycle }, current: restored, sourcePlan: plan(restored) });
  assert.equal(restoration.states.assertions.find((item) => item.id === previous.id).state, "active");
  assert.equal(restoration.states.assertions.find((item) => item.id === next.id).state, "dormant");
  assert.deepEqual(restored.provenance.reportedNumericObservations, before.provenance.reportedNumericObservations);
  assert.deepEqual(validateCandidateLifecycle(lifecycle, { baseline, current, sourcePlan: plan(current) }), []);
});

test("source deletion and retraction withdraw only that news and leave immutable historical references", () => {
  const bodies = [["daily/a.md", "工业增加值同比增长5.2%。"], ["daily/b.md", "工业增加值同比增长5.2%。"]];
  const before = fixture(bodies); const baseline = first(before); const current = fixture(bodies.slice(1));
  const own = descriptions(before).find((item) => !descriptions(current).some((other) => other.id === item.id));
  const surviving = descriptions(current)[0];
  for (const [operation, status] of [["delete", "deleted"], ["retract", "retracted"]]) {
    const sourcePlan = plan(current, { sourceStates: { "daily/a.md": { status, lastHash: before.sourceInventory["daily/a.md"], reviewedAt: generatedAt, reason: "Synthetic source withdrawal" } }, decisions: [{ path: "daily/a.md", operation, fromHash: before.sourceInventory["daily/a.md"], toHash: null, reason: "Synthetic source withdrawal" }] });
    const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan });
    const state = lifecycle.states.assertions.find((item) => item.id === own.id);
    assert.equal(state.state, "dormant"); assert.equal(state.recordRef.bundleId, baseline.bundleId);
    assert.equal(lifecycle.states.assertions.find((item) => item.id === surviving.id).state, "active");
    assert.deepEqual(validateCandidateLifecycle(lifecycle, { baseline, current, sourcePlan }), []);
    assert.doesNotMatch(canonicalJson(lifecycle), /"state":"false"/u);
  }
});

test("form labels withdraw and restore independently of numeric descriptions", () => {
  const unreviewed = fixture(); const selected = structuredClone(rules); selected.reportingFormReviews = [reviewFor(unreviewed)];
  const reviewed = fixture(undefined, selected); const baseline = first(reviewed);
  const lifecycle = buildCandidateLifecycle({ baseline, current: unreviewed, sourcePlan: plan(unreviewed) });
  const labels = reviewed.provenance.assertions.filter((item) => item.predicate === "assigned_reporting_form");
  for (const label of labels) assert.equal(lifecycle.states.assertions.find((item) => item.id === label.id).state, "dormant");
  for (const description of descriptions(reviewed)) assert.equal(lifecycle.states.assertions.find((item) => item.id === description.id).state, "active");
  const restored = buildCandidateLifecycle({ baseline: { ...unreviewed, bundleId: sha256("form-withdrawal"), lifecycle }, current: reviewed, sourcePlan: plan(reviewed) });
  for (const label of labels) assert.equal(restored.states.assertions.find((item) => item.id === label.id).state, "active");
});

test("self-rehashed cross-axis and cross-news supports cannot replace own description supports", () => {
  const value = fixture([["daily/a.md", "工业增加值同比增长5.2%。"], ["daily/b.md", "工业增加值同比增长5.2%。"]]);
  for (const predicate of reportPredicates) {
    if (predicate === "assigned_reporting_form") continue;
    const forged = structuredClone(value.provenance);
    const assertion = forged.assertions.find((item) => item.predicate === predicate);
    const support = forged.supports.find((item) => item.assertionId === assertion.id);
    const classification = forged.classifications.find((item) => item.eventId === assertion.subject);
    for (const key of Object.keys(support)) if (!["id", "assertionId"].includes(key)) delete support[key];
    rehashSupport(forged, support, { method: "classification", decisionId: classification.id });
    assert.throws(() => summarizeCandidateLifecycleInput({ ...value, provenance: forged }), /own exact assessment support set/u);
    assert.ok(validateCandidateProvenance(forged, value).length);
  }
  const forged = structuredClone(value.provenance);
  const support = forged.supports.find((item) => item.method === "fragment_numeric_rule");
  const other = forged.numericObservationAssessments.find((item) => item.id !== support.numericObservationAssessmentId);
  rehashSupport(forged, support, { numericObservationAssessmentId: other.id });
  assert.throws(() => summarizeCandidateLifecycleInput({ ...value, provenance: forged }), /own exact assessment support set/u);
});

test("missing, extra, altered and borrowed occurrence evidence fail independent replay and lifecycle validation", () => {
  const value = fixture([["daily/a.md", "工业增加值同比增长5.2%。"], ["daily/b.md", "工业增加值同比增长5.2%。"]]);
  for (const corrupt of [
    (p) => { p.reportedNumericObservations[0].evidenceIds.pop(); },
    (p) => { p.reportedNumericObservations[0].evidenceIds.push(p.reportedNumericObservations[1].evidenceIds[0]); },
    (p) => { p.reportedNumericObservations[0].evidence.directionEvidenceId = p.reportedNumericObservations[0].evidence.unitEvidenceId; },
    (p) => { p.reportedNumericObservations[0].inputId = p.reportedNumericObservations[1].inputId; },
    (p) => { p.reportedNumericObservations[0].value.decimal = "999"; },
    (p) => { p.evidence.find((item) => item.spanPolicy === "exact_report_description_occurrence").firstRange[0] += 1; },
    (p) => { p.reportedNumericObservations.push({ ...p.reportedNumericObservations[0], id: "reported-numeric-observation-" + "0".repeat(64) }); },
  ]) {
    const forged = structuredClone(value.provenance); corrupt(forged);
    assert.ok(validateCandidateProvenance(forged, value).length);
    assert.throws(() => summarizeCandidateLifecycleInput({ ...value, provenance: forged }));
  }
});

test("report description input comes only from the authenticated exact news fragment", () => {
  const value = fixture();
  const trace = structuredClone(value.trace); trace.news[0].inputs.fragment += "营业收入环比下降3%。";
  assert.throws(() => buildCandidateProvenance({ ...value, trace }), /differs from authenticated fragment/u);
  const kg = structuredClone(value.kg); kg.events[0].numericObservationAssessment.observations[0].value.decimal = "99";
  assert.ok(validateCandidateProvenance(value.provenance, { ...value, kg }).length);
});

test("legacy projections and IDs are deeply unchanged and optional ledger tables are absent", () => {
  const oldRules = structuredClone(rules); delete oldRules.reportingFormReviews; delete oldRules.numericExtraction;
  const oldOntology = structuredClone(ontology); delete oldOntology.reportingForm; delete oldOntology.numericObservation;
  const legacy = fixture(undefined, oldRules, oldOntology); const current = fixture();
  for (const key of ["reportDescriptionVersion", "reportDescriptionWitnessPolicy", "reportingFormAssessments", "numericObservationAssessments", "reportedNumericObservations"]) assert.equal(Object.hasOwn(legacy.provenance, key), false);
  assert.deepEqual(current.kg.events.map(({ reportingFormAssessment, numericObservationAssessment, ...event }) => { void reportingFormAssessment; void numericObservationAssessment; return event; }), legacy.kg.events);
  for (const key of ["entities", "sources", "eventRelations", "entityRelations"]) assert.deepEqual(current.kg[key], legacy.kg[key]);
  for (const key of ["sourceRevisions", "newsRevisions", "dateDerivations", "observations", "retention", "classifications", "chronologyGroups", "actionAssessments", "duplicateContentGroups"]) assert.deepEqual(current.provenance[key], legacy.provenance[key]);
  for (const key of ["assertions", "supports", "assertionRevisions"]) for (const row of legacy.provenance[key]) assert.deepEqual(current.provenance[key].find((item) => item.id === row.id), row);
  assert.deepEqual(validateCandidateProvenance(legacy.provenance, legacy), []);
  assert.doesNotThrow(() => summarizeCandidateLifecycleInput(legacy));
  const forged = structuredClone(legacy.provenance); forged.reportedNumericObservations = [];
  assert.throws(() => summarizeCandidateLifecycleInput({ ...legacy, provenance: forged }), /unexpected reportedNumericObservations/u);
});

test("identical builds and reordered source input preserve canonical report provenance and dependency closure", () => {
  const bodies = [["daily/a.md", "2025年工业增加值同比增长005.200%。"], ["daily/b.md", "营业收入环比下降3%。"]];
  const one = fixture(bodies); const two = fixture([...bodies].reverse());
  assert.equal(canonicalJson(one.provenance), canonicalJson(two.provenance));
  assert.deepEqual(summarizeCandidateLifecycleInput(one), summarizeCandidateLifecycleInput(two));
  const broken = structuredClone(one.provenance);
  const inputId = broken.reportedNumericObservations[0].inputId;
  broken.inputs = broken.inputs.filter((item) => item.id !== inputId);
  assert.throws(() => summarizeCandidateLifecycleInput({ ...one, provenance: broken }), /missing provenance.inputs/u);
  const lifecycle = buildCandidateLifecycle({ baseline: first(one), current: two, sourcePlan: plan(two) });
  assert.equal(lifecycle.transitions.assertions.length, 0);
});
