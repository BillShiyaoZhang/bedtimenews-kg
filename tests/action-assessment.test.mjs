import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { actionAssessmentLabel, actionFilterOptions, actionMatchReasons, actionNewsCount, eventMatchesAction, validateActionAssessment, validateActionAssessmentStructure } from "../app/lib/action-assessment.mjs";
import { hierarchyIndex } from "../app/lib/ontology-hierarchy.mjs";
import { createActionExtractionEngine, validateActionEvidence } from "../scripts/lib/action-extraction.mjs";

const ontology = JSON.parse(await readFile(new URL("../data/ontology.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../data/extraction-rules.json", import.meta.url), "utf8"));
const engine = createActionExtractionEngine(rules.actionExtraction);
const assessed = (raw) => engine.assess(raw);
const event = (raw, newsId = "news-000000000001") => ({ id: `event-${newsId}`, newsId, actionAssessment: assessed(raw) });
const graph = (events) => ({ source: { actionExtractionVersion: "1.0.0", actionNormalizationVersion: "visible-fragment-v1" }, events });
const reported = "甲铁路正式通车。";
const planned = "甲铁路计划通车。";
const mixed = "甲铁路正式通车。北京市法院计划判处张某三年。天然气产量预计同比增长6%。";

test("browser structural checks accept all supported engine results and exact UTF-16 offsets", () => {
  for (const raw of [reported, planned, mixed, "😀甲铁路尚未通车。", "若甲铁路通车则调整班次。", "没有支持模板的静态说明。", "<!-- 甲铁路通车 -->", "甲铁路通车。乙铁路通车。", "甲项目未计划投产。"] ) {
    const assessment = assessed(raw);
    assert.deepEqual(validateActionAssessment(assessment, ontology), [], raw);
    assert.deepEqual(validateActionAssessmentStructure(graph([{ actionAssessment: assessment }]), ontology), [], raw);
  }
});

test("structural checks fail closed on forged fields, enums, targets and empty claims", () => {
  for (const mutate of [
    (value) => { value.occurrenceId = "fake-real-world-event"; },
    (value) => { delete value.review; },
    (value) => { value.status = "verified"; },
    (value) => { value.reasonCode = "unknown"; },
    (value) => { value.assignments = {}; },
    (value) => { value.assignments = []; },
    (value) => { value.assignments[0] = null; },
    (value) => { value.assignments[0].actor = "unverified person"; },
    (value) => { value.assignments[0].conceptId = "missing"; },
    (value) => { value.assignments[0].conceptId = "topic-labor"; },
    (value) => { value.assignments[0].conceptId = "class-person"; },
    (value) => { value.assignments[0].conceptId = "action"; },
    (value) => { value.assignments[0].conceptId = "action-research"; },
    (value) => { value.assignments[0].polarity = "positive"; },
    (value) => { value.assignments[0].modality = "confirmed"; },
    (value) => { value.assignments[0].evidence = []; },
    (value) => { value.assignments[0].evidence = {}; },
    (value) => { value.assignments[0].evidence[0].verified = true; },
    (value) => { value.assignments[0].evidence[0].ruleId = ""; },
  ]) {
    const invalid = assessed(planned);
    mutate(invalid);
    assert.ok(validateActionAssessment(invalid, ontology).length);
  }
  for (const invalid of [null, undefined, [], "applicable"]) assert.ok(validateActionAssessment(invalid, ontology).length);
});

test("predicate and qualifier spans must be integer UTF-16 spans agreeing exactly with their scope", () => {
  for (const mutate of [
    (value) => { value.predicate.start = -1; },
    (value) => { value.predicate.start += 0.5; },
    (value) => { value.predicate.end = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.predicate.text = "开工"; },
    (value) => { value.predicate.end += 1; },
    (value) => { value.predicate.end = value.predicate.start; },
    (value) => { value.scope.start = value.predicate.start + 1; value.scope.text = value.scope.text.slice(value.scope.start); },
    (value) => { value.scope.end -= 2; value.scope.text = value.scope.text.slice(0, -2); },
    (value) => { value.scope.text = "x".repeat(value.scope.text.length); },
    (value) => { value.scope.normalizationVersion = "unknown"; },
    (value) => { value.qualifiers = {}; },
    (value) => { value.qualifiers[0].start = 0.5; },
    (value) => { value.qualifiers[0].text = "预计"; },
    (value) => { value.qualifiers[0].kind = "certainty"; },
    (value) => { value.qualifiers[0].value = "verified"; },
    (value) => { value.qualifiers[0].value = "predicted"; },
    (value) => { value.qualifiers[0].id = "unexpected"; },
    (value) => { value.qualifiers[0].start = value.scope.end; value.qualifiers[0].end = value.scope.end + 2; },
  ]) {
    const invalid = assessed(planned);
    mutate(invalid.assignments[0].evidence[0]);
    assert.ok(validateActionAssessment(invalid, ontology).length);
  }
});

test("non-default polarity and modality require local matching qualifiers in every witness", () => {
  const without = assessed(planned);
  without.assignments[0].evidence[0].qualifiers = [];
  assert.ok(validateActionAssessment(without, ontology).length);
  const recast = assessed(planned);
  recast.assignments[0].modality = "reported";
  assert.ok(validateActionAssessment(recast, ontology).length);
  const negated = assessed("甲铁路未通车。");
  negated.assignments[0].evidence[0].qualifiers = [];
  assert.ok(validateActionAssessment(negated, ontology).length);
  const multiple = assessed("甲铁路计划通车。乙铁路计划通车。");
  multiple.assignments[0].evidence[1].qualifiers = [];
  assert.ok(validateActionAssessment(multiple, ontology).length);
});

test("duplicates and conflicting repeated predicate claims are rejected", () => {
  for (const mutate of [
    (value) => { value.assignments.push(structuredClone(value.assignments[0])); },
    (value) => { value.assignments[0].evidence.push(structuredClone(value.assignments[0].evidence[0])); },
    (value) => { value.assignments[0].evidence[0].qualifiers.push(structuredClone(value.assignments[0].evidence[0].qualifiers[0])); },
    (value) => { const copy = structuredClone(value.assignments[0]); copy.modality = "reported"; copy.evidence[0].qualifiers = []; value.assignments.push(copy); },
  ]) {
    const invalid = assessed(planned);
    mutate(invalid);
    assert.ok(validateActionAssessment(invalid, ontology).length);
  }
  assert.deepEqual(validateActionAssessment(assessed("甲铁路通车。乙铁路通车。"), ontology), []);
});

test("overlapping scope witnesses cannot disagree about their shared source text", () => {
  const invalid = assessed("甲铁路通车。乙铁路通车。");
  const first = invalid.assignments[0].evidence[0];
  const second = invalid.assignments[0].evidence[1];
  second.scope = { start: 0, end: second.scope.end, text: "x".repeat(second.scope.start) + second.scope.text };
  assert.ok(second.scope.end > first.scope.end);
  assert.ok(validateActionAssessment(invalid, ontology).some((issue) => issue.message.includes("重叠")));
});

test("reviewed not_applicable, unmatched and supported states are mutually consistent", () => {
  const review = { id: "review-static-v1", reviewedAt: "2026-09-30T00:00:00Z", reason: "经审查为静态观察。", evidence: { start: 0, end: 4, text: "静态观察" } };
  const reviewed = { status: "not_applicable", reasonCode: "reviewed_not_applicable", assignments: [], review };
  assert.deepEqual(validateActionAssessment(reviewed, ontology), []);
  for (const mutate of [
    (value) => { value.review = null; },
    (value) => { value.reasonCode = "no_supported_rule"; },
    (value) => { value.status = "undetermined"; },
    (value) => { value.assignments = assessed(reported).assignments; },
    (value) => { value.review.id = ""; },
    (value) => { value.review.reviewedAt = "2026-02-30T00:00:00Z"; },
    (value) => { value.review.reviewedAt = "2026-09-30"; },
    (value) => { value.review.reason = ""; },
    (value) => { value.review.evidence.text = ""; },
    (value) => { value.review.evidence.end = 5; },
    (value) => { value.review.signature = "not-authorized"; },
  ]) {
    const invalid = structuredClone(reviewed);
    mutate(invalid);
    assert.ok(validateActionAssessment(invalid, ontology).length);
  }
  const unknown = assessed("静态观察。");
  unknown.reasonCode = "reviewed_not_applicable";
  assert.ok(validateActionAssessment(unknown, ontology).length);
});

test("current graphs require complete action metadata and every event assessment", () => {
  for (const invalid of [null, {}, { source: {}, events: {} }, graph([null])]) assert.ok(validateActionAssessmentStructure(invalid, ontology).length);
  for (const mutate of [
    (value) => { delete value.source.actionExtractionVersion; },
    (value) => { value.source.actionExtractionVersion = "2.0.0"; },
    (value) => { value.source.actionNormalizationVersion = "raw"; },
    (value) => { delete value.events[0].actionAssessment; },
  ]) {
    const invalid = graph([event(reported)]);
    mutate(invalid);
    assert.ok(validateActionAssessmentStructure(invalid, ontology).length);
  }
  for (const mutate of [
    (value) => { delete value.actionAssessment; },
    (value) => { value.actionAssessment.schemaVersion = 2; },
    (value) => { value.actionAssessment.statuses[0].id = "verified"; },
    (value) => { value.actionAssessment.modalities.pop(); },
    (value) => { value.actionAssessment.polarities[0].label = ""; },
  ]) {
    const invalid = structuredClone(ontology);
    mutate(invalid);
    assert.ok(validateActionAssessmentStructure(graph([event(reported)]), invalid).length);
  }
});

test("historical compiler graphs may omit action data but cannot mix in the new contract", () => {
  const historical = structuredClone(ontology);
  historical.compilation.compilerVersion = "1.0.0";
  delete historical.actionAssessment;
  assert.deepEqual(validateActionAssessmentStructure({ source: {}, events: [{ id: "old" }] }, historical), []);
  assert.ok(validateActionAssessmentStructure(graph([event(reported)]), historical).length);
});

test("source-free structure is deliberately not a substitute for authoritative source replay", () => {
  const forged = assessed(reported);
  const evidence = forged.assignments[0].evidence[0];
  evidence.scope.text = evidence.scope.text.replace("甲", "乙");
  assert.deepEqual(validateActionAssessment(forged, ontology), []);
  assert.ok(validateActionEvidence(forged, reported, rules.actionExtraction).length);
});

test("class, polarity and modality filters must match the same assignment", () => {
  const item = event(mixed);
  assert.equal(item.actionAssessment.assignments.length, 3);
  assert.equal(eventMatchesAction(ontology, item, { conceptId: "action-engineering", modality: "planned" }), false);
  assert.equal(eventMatchesAction(ontology, item, { conceptId: "action-legal", modality: "planned", polarity: "affirmative", status: "applicable" }), true);
  assert.equal(eventMatchesAction(ontology, item, { conceptId: "change-quantitative", modality: "predicted" }), true);
  assert.equal(eventMatchesAction(ontology, item, { conceptId: "action-legal", modality: "predicted" }), false);
  const negative = event("甲铁路尚未通车。北京市法院计划判处张某三年。");
  assert.equal(eventMatchesAction(ontology, negative, { conceptId: "action-legal", polarity: "negated" }), false);
  assert.equal(eventMatchesAction(ontology, negative, { conceptId: "action-engineering", polarity: "negated", modality: "reported" }), true);
});

test("unknown, reviewed and incompatible applicability filters return explicit zero matches", () => {
  const unknown = event("静态观察。");
  assert.equal(eventMatchesAction(ontology, unknown, { status: "undetermined" }), true);
  assert.equal(eventMatchesAction(ontology, unknown, { status: "not_applicable" }), false);
  assert.equal(eventMatchesAction(ontology, unknown, { status: "undetermined", conceptId: "occurrence" }), false);
  assert.equal(eventMatchesAction(ontology, unknown, { modality: "reported" }), false);
  const reviewed = { newsId: "news-000000000002", actionAssessment: { status: "not_applicable", reasonCode: "reviewed_not_applicable", assignments: [], review: {} } };
  assert.equal(eventMatchesAction(ontology, reviewed, { status: "not_applicable" }), true);
  assert.equal(eventMatchesAction(ontology, reviewed, { status: "not_applicable", polarity: "affirmative" }), false);
  assert.equal(actionNewsCount(ontology, [unknown, reviewed], "action"), 0);
  assert.deepEqual(actionMatchReasons(ontology, unknown, { conceptId: "action" }), []);
  assert.equal(eventMatchesAction(ontology, { newsId: "historical" }, { status: "undetermined" }), false);
});

test("repeated occurrences, repeated requests and reset do not multiply or retain results", () => {
  const first = event("甲铁路正式通车。乙铁路正式通车。");
  const second = event(planned, "news-000000000002");
  const events = [first, second, structuredClone(first)];
  assert.equal(first.actionAssessment.assignments[0].evidence.length, 2);
  const selected = { conceptId: "action-engineering", modality: "reported" };
  const snapshot = JSON.stringify([events, selected]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(actionNewsCount(ontology, events, "action-engineering", selected), 1);
    assert.equal(actionNewsCount(ontology, events, "action-engineering", { modality: "planned" }), 1);
    assert.equal(actionNewsCount(ontology, events, "action-engineering"), 2);
    assert.equal(eventMatchesAction(ontology, second, { conceptId: "", status: "", polarity: "", modality: "" }), true);
    assert.equal(eventMatchesAction(ontology, { newsId: "historical" }, {}), true);
  }
  assert.equal(JSON.stringify([events, selected]), snapshot);
});

test("ancestor navigation explains inherited assignments without mixing sibling classes", () => {
  const item = event(reported);
  const reasons = actionMatchReasons(ontology, item, { conceptId: "action" });
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].conceptId, "action-engineering");
  assert.equal(reasons[0].inherited, true);
  assert.equal(actionMatchReasons(ontology, item, { conceptId: "action-engineering" })[0].inherited, false);
  assert.equal(eventMatchesAction(ontology, item, { conceptId: "state-change" }), false);
  assert.equal(eventMatchesAction(ontology, item, { conceptId: "action-research" }), false);
  assert.equal(actionNewsCount(ontology, [item], "occurrence"), 1);
});

test("DAG ancestry and navigation count each news once through multiple paths", () => {
  const diamond = structuredClone(ontology);
  const leaf = diamond.hierarchies.action.nodes.find((node) => node.id === "action-engineering");
  leaf.parentIds.push("state-change");
  Object.assign(diamond.hierarchies.action, hierarchyIndex(diamond.hierarchies.action));
  const item = event("甲铁路通车。乙铁路通车。");
  assert.equal(actionNewsCount(diamond, [item, structuredClone(item)], "occurrence"), 1);
  assert.equal(actionNewsCount(diamond, [item], "action"), 1);
  assert.equal(actionNewsCount(diamond, [item], "state-change"), 1);
  assert.equal(actionMatchReasons(diamond, item, { conceptId: "occurrence" }).length, 1);
  const options = actionFilterOptions(diamond, [item]);
  assert.equal(options.filter((option) => option.id === leaf.id).length, 1);
  assert.ok(options.every((option) => diamond.hierarchies.action.nodes.find((node) => node.id === option.id).status === "active"));
  assert.equal(leaf.primaryParentId, "action");
});

test("filters reject unknown IDs and source-controlled display labels follow ontology renaming", () => {
  for (const filter of [{ conceptId: "not-a-concept" }, { conceptId: 0 }, { status: null }, { polarity: false }, { status: "verified" }, { polarity: "positive" }, { modality: "past" }, { ruleId: "unrequested" }]) assert.throws(() => eventMatchesAction(ontology, event(reported), filter));
  const changed = structuredClone(ontology);
  changed.actionAssessment.modalities.find((entry) => entry.id === "planned").label = "计划名称测试";
  changed.hierarchies.action.nodes.find((node) => node.id === "action-engineering").label = "工程名称测试";
  assert.equal(actionAssessmentLabel(changed, "modalities", "planned"), "计划名称测试");
  assert.equal(actionMatchReasons(changed, event(planned))[0].label, "工程名称测试");
  assert.ok(actionFilterOptions(changed, [event(planned)]).find((option) => option.id === "action-engineering").label.includes("工程名称测试"));
});

test("browser helper has no Node, source archive or rule-engine dependency", async () => {
  const source = await readFile(new URL("../app/lib/action-assessment.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'](?:node:|.*scripts\/|.*sources\/)/u);
});
