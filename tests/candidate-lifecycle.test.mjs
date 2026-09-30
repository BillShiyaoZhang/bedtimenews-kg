import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { buildCandidateLifecycle, summarizeCandidateLifecycleInput, validateCandidateLifecycle } from "../scripts/lib/candidate-lifecycle.mjs";
import { buildKnowledgeGraph } from "../scripts/lib/kg-build.mjs";
import { buildCandidateProvenance } from "../scripts/lib/candidate-provenance.mjs";
import { parseSourcePage } from "../scripts/lib/news.mjs";

const A = sha256("bundle-a");
const B = sha256("bundle-b");
const C = sha256("bundle-c");
const h = (value) => sha256(canonicalJson(value));
const reference = (bundleId, recordId) => ({ bundleId, recordId });
const entityId = "entity-organization-legacy-name";
const topicId = "entity-topic-pinned-legacy-id";
const sourceHash = sha256("immutable source bytes");
const scope = "extraction_assignment";

// Two articles can mention the same entity using identical text. The source,
// news, observation and assignment identities still belong to their own article.
function fixture({ articleIds = ["one", "two"], methods = ["direct", "rescan"], retained = true, retentionRevision = "retention-r1", witness = "ACME" } = {}) {
  const entities = retained && articleIds.length ? [
    { id: entityId, type: "organization", label: "ACME", extraction: { method: "organization_alias" } },
    { id: topicId, type: "topic", label: "Labor" },
  ] : [];
  const pages = articleIds.map((id) => ({ id: `page-${id}`, repositoryPath: `daily/${id}.md`, contentHash: sourceHash }));
  const items = articleIds.map((id) => ({ id: `news-${id}`, pageId: `page-${id}`, title: "Same text", fragment: { contentHash: sha256("same fragment") } }));
  const events = articleIds.map((id) => ({ id: `event-${id}`, newsId: `news-${id}`, entityIds: retained ? [entityId, topicId] : [], type: "labor", sourceIds: [`page-${id}`] }));
  const provenance = { epistemicScope: scope, sourceRevisions: [], newsRevisions: [], dateDerivations: [], inputs: [], evidence: [], observations: [], retention: [], classifications: [], chronologyGroups: [], assertions: [], supports: [], assertionRevisions: [], duplicateContentGroups: [] };
  for (const id of articleIds) {
    provenance.sourceRevisions.push({ id: `source-revision-${id}`, repositoryPath: `daily/${id}.md`, contentHash: sourceHash });
    provenance.newsRevisions.push({ id: `news-revision-${id}`, newsId: `news-${id}`, sourceRevisionId: `source-revision-${id}`, recordHash: h(items.find((item) => item.id === `news-${id}`)) });
    provenance.inputs.push({ id: `input-${id}`, newsRevisionId: `news-revision-${id}`, contentHash: sha256(witness) });
    provenance.evidence.push({ id: `evidence-${id}`, inputId: `input-${id}`, text: witness, firstRange: [0, witness.length] });
    provenance.observations.push({ id: `observation-${id}`, newsRevisionId: `news-revision-${id}`, evidenceIds: [`evidence-${id}`], entityId, revisionId: `observation-revision-${id}` });
    provenance.classifications.push({ id: `classification-${id}`, eventId: `event-${id}`, newsRevisionId: `news-revision-${id}`, type: "labor", steps: [] });
    const assigned = [];
    if (retained && methods.length) for (const target of [entityId, topicId]) {
      const assertionId = `assertion-${id}-${target}`;
      assigned.push({ id: assertionId, subject: `event-${id}`, predicate: "assigned_entity", object: target, epistemicScope: scope });
      for (const method of methods) provenance.supports.push({
        id: `support-${id}-${target}-${method}`, assertionId,
        method: method === "direct" ? "direct_extraction" : "global_name_rescan",
        ...(method === "direct" ? { observationId: `observation-${id}` } : { newsRevisionId: `news-revision-${id}`, evidenceIds: [`evidence-${id}`] }),
        prerequisiteIds: [`retention-${target}`],
      });
    }
    const domainId = `assertion-${id}-domain`;
    assigned.push({ id: domainId, subject: `event-${id}`, predicate: "assigned_legacy_domain", object: "labor", epistemicScope: scope });
    provenance.supports.push({ id: `support-${id}-domain`, assertionId: domainId, method: "classification", decisionId: `classification-${id}` });
    provenance.assertions.push(...assigned);
  }
  if (articleIds.length) for (const target of [entityId, topicId]) provenance.retention.push({ id: `retention-${target}`, revisionId: retentionRevision, entityId: target, retained, distinctNewsCount: articleIds.length, observationIds: articleIds.map((id) => `observation-${id}`) });
  reviseAssertions(provenance);
  return {
    kg: { entities, events, eventRelations: [], entityRelations: [], sources: pages },
    news: { pages, news: items },
    provenance,
  };
}

function reviseAssertions(provenance) {
  provenance.assertionRevisions = provenance.assertions.map((assertion) => {
    const record = { assertionId: assertion.id, state: "materialized", supportIds: provenance.supports.filter((support) => support.assertionId === assertion.id).map((support) => support.id).sort() };
    return { id: `assertion-revision-${h(record).slice(0, 24)}`, ...record };
  });
}

function plan(snapshot, { sourceStates = {}, decisions = [] } = {}) {
  const effectiveInventory = Object.fromEntries(snapshot.news.pages.map((page) => [page.repositoryPath, page.contentHash]));
  return { observedInventory: { ...effectiveInventory }, effectiveInventory, sourceStates, decisions };
}

function first(snapshot = fixture()) {
  return { bundleId: A, ...snapshot, lifecycle: buildCandidateLifecycle({ current: snapshot, sourcePlan: plan(snapshot) }) };
}

test("genesis records only current states with explicit extraction scope and legacy identity basis", () => {
  const current = fixture();
  const lifecycle = buildCandidateLifecycle({ current, sourcePlan: plan(current) });
  assert.equal(lifecycle.epistemicScope, scope);
  assert.equal(lifecycle.parentBundleId, null);
  assert.deepEqual(lifecycle.referencedBundleIds, []);
  assert.deepEqual(lifecycle.initialization, { entities: 2, news: 2, assertions: 6 });
  assert.deepEqual(lifecycle.transitions.records.collections, {});
  assert.equal(lifecycle.transitions.assertions.length, 0);
  for (const rows of Object.values(lifecycle.states)) assert.ok(rows.every((row) => row.state === "active" && row.recordRef.bundleId === "self"));
  assert.deepEqual(lifecycle.states.entities.find((row) => row.id === entityId).identityBasis, { kind: "legacy_type_name", key: "organization:acme" });
  assert.deepEqual(lifecycle.states.entities.find((row) => row.id === topicId).identityBasis, { kind: "pinned_topic_id", key: topicId });
  assert.match(lifecycle.identitySemantics, /not_resolved_real_world_identity/u);
  assert.deepEqual(validateCandidateLifecycle(lifecycle, { current, sourcePlan: plan(current) }), []);
});

test("removing one derivation keeps an assertion active while recording other support remaining", () => {
  const baseline = first();
  const current = fixture({ methods: ["rescan"] });
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan: plan(current) });
  const id = `assertion-one-${entityId}`;
  const transition = lifecycle.transitions.assertions.find((row) => row.id === id);
  assert.equal(lifecycle.states.assertions.find((row) => row.id === id).state, "active");
  assert.equal(transition.transition, "changed");
  assert.equal(transition.reason, "other_supports_remain");
  assert.deepEqual(transition.supportChanges.removed, [reference(A, `support-one-${entityId}-direct`)]);
  assert.equal(transition.supportChanges.survivingCount, 1);
  assert.equal(transition.supportChanges.currentCount, 1);
  assert.equal(transition.beforeRevision.bundleId, A);
  assert.equal(transition.afterRevision.bundleId, "self");
  assert.equal(lifecycle.transitions.records.collections["provenance.supports"].removed.length, 4);
});

test("last support loss makes assignments and no-longer-materialized entities dormant, never false", () => {
  const baseline = first();
  const current = fixture({ retained: false });
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan: plan(current) });
  const id = `assertion-one-${entityId}`;
  const state = lifecycle.states.assertions.find((row) => row.id === id);
  assert.equal(state.state, "dormant");
  assert.deepEqual(state.recordRef, reference(A, id));
  assert.equal(state.assertionRevisionRef.bundleId, A);
  assert.equal(lifecycle.transitions.assertions.find((row) => row.id === id).reason, "last_support_removed");
  assert.equal(lifecycle.transitions.assertions.find((row) => row.id === id).supportChanges.currentCount, 0);
  assert.ok(lifecycle.states.entities.every((row) => row.state === "dormant"));
  assert.ok(lifecycle.states.news.every((row) => row.state === "active"));
  assert.ok(lifecycle.states.assertions.filter((row) => row.state === "active").every((row) => row.id.endsWith("-domain")));
  assert.doesNotMatch(canonicalJson(lifecycle), /"state":"false"|"truth"/u);
});

test("stable support IDs retain bundle-scoped old prerequisites when retention revisions change", () => {
  const baseline = first();
  const current = fixture({ retentionRevision: "retention-r2" });
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan: plan(current) });
  const id = `assertion-one-${entityId}`;
  const transition = lifecycle.transitions.assertions.find((row) => row.id === id);
  assert.equal(transition.reason, "record_or_derivation_revised");
  assert.equal(transition.beforeRevision.recordId, transition.afterRevision.recordId);
  assert.notEqual(transition.beforeRevision.bundleId, transition.afterRevision.bundleId);
  assert.equal(transition.supportChanges.survivingCount, 0);
  assert.equal(transition.supportChanges.changed.length, 2);
  const snapshots = new Map([[A, baseline], ["self", current]]);
  const lookup = (pointer, collection) => snapshots.get(pointer.bundleId).provenance[collection].find((row) => row.id === pointer.recordId);
  const oldRevision = lookup(transition.beforeRevision, "assertionRevisions");
  const oldSupportRef = reference(transition.beforeRevision.bundleId, oldRevision.supportIds[0]);
  const oldSupport = lookup(oldSupportRef, "supports");
  assert.equal(lookup(reference(oldSupportRef.bundleId, oldSupport.prerequisiteIds[0]), "retention").revisionId, "retention-r1");
  assert.equal(lookup(reference("self", oldSupport.prerequisiteIds[0]), "retention").revisionId, "retention-r2");
  const retentionChange = lifecycle.transitions.records.collections["provenance.retention"].changed.find((row) => row.id === `retention-${entityId}`);
  assert.deepEqual(retentionChange.before, reference(A, `retention-${entityId}`));
  assert.deepEqual(retentionChange.after, reference("self", `retention-${entityId}`));
  assert.notEqual(retentionChange.oldHash, retentionChange.newHash);
});

test("a reused support ID with revised prerequisites is not reported as a preserved derivation", () => {
  const baseline = first();
  const current = fixture({ methods: ["rescan"], retentionRevision: "retention-r2" });
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan: plan(current) });
  const transition = lifecycle.transitions.assertions.find((row) => row.id === `assertion-one-${entityId}`);
  assert.equal(transition.supportChanges.removed.length, 1);
  assert.equal(transition.supportChanges.changed.length, 1);
  assert.equal(transition.supportChanges.survivingCount, 0);
  assert.equal(transition.supportChanges.currentCount, 1);
  assert.equal(transition.reason, "record_or_derivation_revised");
  assert.equal(lifecycle.states.assertions.find((row) => row.id === transition.id).state, "active");
});

test("dormant news, entities and assertions survive empty generations and restore their legacy IDs", () => {
  const baseline = first();
  const empty = fixture({ articleIds: [] });
  const deleteDecision = { path: "daily/one.md", operation: "delete", fromHash: sourceHash, toHash: null, reason: "Reviewed physical removal" };
  const sourceStates = { "daily/one.md": { status: "deleted", lastHash: sourceHash, reviewedAt: "2026-09-30T00:00:00Z", reason: deleteDecision.reason } };
  const withdrawn = buildCandidateLifecycle({ baseline, current: empty, sourcePlan: plan(empty, { sourceStates, decisions: [deleteDecision] }) });
  assert.ok(Object.values(withdrawn.states).flat().every((state) => state.state === "dormant"));
  assert.deepEqual(withdrawn.transitions.news.find((row) => row.id === "news-one").sourceDecisionPaths, ["daily/one.md"]);
  const carried = buildCandidateLifecycle({ baseline: { bundleId: B, ...empty, lifecycle: withdrawn }, current: empty, sourcePlan: plan(empty, { sourceStates }) });
  assert.deepEqual(carried.states, withdrawn.states);
  assert.deepEqual(carried.referencedBundleIds, [A, B].sort());
  assert.equal(carried.transitions.assertions.length, 0);
  const restored = buildCandidateLifecycle({ baseline: { bundleId: C, ...empty, lifecycle: carried }, current: baseline, sourcePlan: plan(baseline, { decisions: [{ ...deleteDecision, operation: "restore", fromHash: null, toHash: sourceHash, reason: "Reviewed restoration" }] }) });
  assert.ok(Object.values(restored.states).flat().every((state) => state.state === "active"));
  for (const kind of ["entities", "news", "assertions"]) {
    assert.deepEqual(restored.states[kind].map((row) => row.id), baseline.lifecycle.states[kind].map((row) => row.id));
    assert.ok(restored.transitions[kind].every((row) => row.transition === "restored" && row.reason === "same_legacy_id_rematerialized" && row.before.bundleId === A && row.after.bundleId === "self"));
  }
  assert.deepEqual(restored.referencedBundleIds, [A, C].sort());
});

test("identical article fragments do not merge assertion identities or borrow another article's support", () => {
  const baseline = first();
  const current = fixture({ articleIds: ["two"] });
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan: plan(current) });
  assert.deepEqual(lifecycle.states.assertions.find((row) => row.id === `assertion-one-${entityId}`).newsIds, ["news-one"]);
  assert.deepEqual(lifecycle.states.assertions.find((row) => row.id === `assertion-two-${entityId}`).newsIds, ["news-two"]);
  assert.equal(lifecycle.states.assertions.find((row) => row.id === `assertion-one-${entityId}`).state, "dormant");
  assert.equal(lifecycle.states.assertions.find((row) => row.id === `assertion-two-${entityId}`).state, "active");
  assert.equal(lifecycle.states.entities.find((row) => row.id === entityId).state, "active");
  const forged = fixture();
  forged.provenance.supports.find((row) => row.id === `support-one-${entityId}-direct`).observationId = "observation-two";
  assert.throws(() => summarizeCandidateLifecycleInput(forged), /cross-news support/u);
});

test("forged current lifecycle states, transitions and scoped references fail deterministic reconstruction", () => {
  const baseline = first();
  const current = fixture({ retained: false });
  const options = { baseline, current, sourcePlan: plan(current) };
  const expected = buildCandidateLifecycle(options);
  for (const corrupt of [
    (value) => { value.states.assertions.find((row) => row.state === "dormant").state = "active"; },
    (value) => { value.states.news[0].recordRef.bundleId = A; },
    (value) => { value.states.entities.push({ id: "invented", state: "active", recordRef: reference("self", "invented") }); },
    (value) => { value.transitions.assertions.pop(); },
    (value) => { value.referencedBundleIds = []; },
  ]) {
    const forged = structuredClone(expected);
    corrupt(forged);
    assert.equal(validateCandidateLifecycle(forged, options).length, 1);
  }
  const poisonedBaseline = structuredClone(baseline);
  poisonedBaseline.lifecycle.states.entities[0].state = "dormant";
  poisonedBaseline.lifecycle.states.entities.push({ id: "invented", state: "active", recordRef: reference("self", "invented") });
  assert.deepEqual(buildCandidateLifecycle({ ...options, baseline: poisonedBaseline }), expected, "stored active claims never establish state; ancestry replay separately verifies inherited dormant claims");
});

test("compact summaries match full inputs, are order independent and do not retain large witnesses", () => {
  const baseline = first(fixture({ witness: "ACME ".repeat(10000) }));
  const current = fixture({ methods: ["direct"] });
  const options = { baseline, current, sourcePlan: plan(current) };
  const beforeText = canonicalJson(options);
  const expected = buildCandidateLifecycle(options);
  const summary = summarizeCandidateLifecycleInput(baseline);
  assert.ok(canonicalJson(summary).length < canonicalJson(baseline.provenance).length / 3);
  assert.ok(!canonicalJson(summary).includes("ACME ACME"));
  assert.deepEqual(buildCandidateLifecycle({ ...options, baseline: { bundleId: A, summary, lifecycle: baseline.lifecycle }, current: { summary: summarizeCandidateLifecycleInput(current) } }), expected);
  const permuted = structuredClone(current);
  for (const object of [permuted.kg, permuted.news, permuted.provenance]) for (const value of Object.values(object)) if (Array.isArray(value)) value.reverse();
  assert.deepEqual(buildCandidateLifecycle({ ...options, current: permuted }), expected);
  assert.equal(canonicalJson(options), beforeText, "builder must not mutate its inputs");
});

test("record transitions compare content as well as IDs and source review reasons are preserved", () => {
  const baseline = first();
  const current = fixture();
  current.provenance.evidence[0].firstRange = [4, 8];
  const decision = { path: "daily/one.md", operation: "revise", fromHash: sourceHash, toHash: sha256("revised source bytes"), reason: "Reviewed replacement; not a real-world truth judgment" };
  const sourcePlan = plan(current, { decisions: [decision] });
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan });
  const changed = lifecycle.transitions.records.collections["provenance.evidence"].changed;
  assert.equal(changed.length, 1);
  assert.notEqual(changed[0].oldHash, changed[0].newHash);
  assert.deepEqual(changed[0].before, reference(A, "evidence-one"));
  assert.deepEqual(lifecycle.decisions, [decision]);
  assert.deepEqual(lifecycle.observedInventory, sourcePlan.observedInventory);
  assert.deepEqual(lifecycle.effectiveInventory, sourcePlan.effectiveInventory);
  assert.deepEqual(lifecycle.transitions.assertions.find((row) => row.id === `assertion-one-${entityId}`).sourceDecisionPaths, [decision.path]);
});

test("persistent identity payload is bounded by known identities, not by generation count", () => {
  const empty = fixture({ articleIds: [] });
  let lifecycle = buildCandidateLifecycle({ baseline: first(), current: empty, sourcePlan: plan(empty) });
  const persistentStates = structuredClone(lifecycle.states);
  let stableBytes;
  for (let generation = 0; generation < 25; generation += 1) {
    lifecycle = buildCandidateLifecycle({ baseline: { bundleId: sha256(`generation-${generation}`), ...empty, lifecycle }, current: empty, sourcePlan: plan(empty) });
    assert.deepEqual(lifecycle.states, persistentStates);
    assert.equal(lifecycle.referencedBundleIds.length, 2);
    assert.equal(lifecycle.transitions.assertions.length, 0);
    const bytes = canonicalJson(lifecycle).length;
    if (stableBytes) assert.equal(bytes, stableBytes);
    stableBytes = bytes;
    assert.ok(!Object.hasOwn(lifecycle, "provenance") && !Object.hasOwn(lifecycle, "history"));
  }
});

test("real extraction replay preserves multi-news chronology scopes through reviewed withdrawal", async () => {
  const [ontology, rules] = await Promise.all(["ontology.json", "extraction-rules.json"].map(async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"))));
  const generatedAt = "2026-01-03T00:00:00Z";
  function extract(days) {
    const pages = []; const news = []; const rawPages = new Map(); const sourceInventory = {};
    for (const day of days) {
      const date = `2026-01-0${day}`;
      const path = `daily/${date}.md`;
      const raw = `---\ntitle: 华为比亚迪介绍工资安排\ndescription: 工资与排班\npublished: true\ndateCreated: ${date}T00:00:00Z\n---\n\n华为和比亚迪在北京市介绍工资和排班安排。\n`;
      const parsed = parseSourcePage(path, raw);
      pages.push(parsed.page); news.push(...parsed.news);
      rawPages.set(parsed.page.id, raw); sourceInventory[path] = sha256(raw);
    }
    const dataset = { schemaVersion: "1.1.0", generatedAt, segmentation: { version: "1.4.0", overrideVersion: "1.1.0" }, pages, news };
    const built = buildKnowledgeGraph({ dataset, rawPages, ontology, rules, generatedAt, collectTrace: true });
    const provenance = buildCandidateProvenance({ ...built, dataset, rawPages, sourceInventory, bindings: {} });
    return { kg: built.kg, news: dataset, provenance };
  }
  const baseline = first(extract([1, 2, 3]));
  assert.ok(baseline.provenance.supports.some((row) => row.method === "news_date_chronology"));
  const current = extract([1, 3]);
  const lifecycle = buildCandidateLifecycle({ baseline, current, sourcePlan: plan(current) });
  const chronologies = current.provenance.assertions.filter((row) => row.predicate === "news_date_precedes");
  assert.ok(chronologies.length);
  for (const assertion of chronologies) {
    const state = lifecycle.states.assertions.find((row) => row.id === assertion.id);
    assert.equal(state.state, "active");
    assert.equal(state.newsIds.length, 2);
    assert.ok(state.newsIds.every((id) => current.news.news.some((item) => item.id === id)));
  }
  assert.equal(lifecycle.states.news.filter((row) => row.state === "dormant").length, 1);
  assert.deepEqual(validateCandidateLifecycle(lifecycle, { baseline, current, sourcePlan: plan(current) }), []);
});
