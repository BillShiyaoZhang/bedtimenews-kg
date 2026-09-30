import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { buildCandidateLifecycle, summarizeCandidateLifecycleInput, validateCandidateLifecycle } from "../scripts/lib/candidate-lifecycle.mjs";
import { ENTITY_IDENTITY_SCOPE, assignedEntityAssertionId, buildReviewedIdentityInputHash, compileEntityIdentities } from "../scripts/lib/entity-identities.mjs";

const h = (value) => sha256(canonicalJson(value));
const A = sha256("identity-bundle-a"), B = sha256("identity-bundle-b"), C = sha256("identity-bundle-c");
const times = ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"];
const rawIds = ["entity-organization-raw-a", "entity-organization-raw-b"];
const identityIds = ["identity-acme-one", "identity-acme-two"];
const reference = (bundleId, recordId) => ({ bundleId, recordId });

function fixture({ articles = ["one", "two"], links = { one: [rawIds[0]], two: [rawIds[1]] }, witness = "ACME", retentionRevision = "retention-v1" } = {}) {
  const pages = articles.map((id) => ({ id: `source-${id}`, repositoryPath: `daily/${id}.md`, contentHash: sha256(`source ${id}`) }));
  const items = articles.map((id) => ({ id: `news-${id}`, pageId: `source-${id}`, title: "Same headline", summary: "Same summary", fragment: { contentHash: sha256("same fragment") } }));
  const events = articles.map((id) => ({ id: `event-${id}`, newsId: `news-${id}`, entityIds: links[id] ?? [], sourceIds: [`source-${id}`] }));
  const usedIds = [...new Set(events.flatMap((event) => event.entityIds))];
  const entities = usedIds.map((id) => ({ id, type: "organization", label: id, aliases: [] }));
  const provenance = { epistemicScope: "extraction_assignment", sourceRevisions: [], newsRevisions: [], dateDerivations: [], inputs: [], evidence: [], observations: [], retention: [], classifications: [], chronologyGroups: [], assertions: [], supports: [], assertionRevisions: [], duplicateContentGroups: [] };
  for (const article of articles) {
    provenance.sourceRevisions.push({ id: `source-revision-${article}`, repositoryPath: `daily/${article}.md`, contentHash: sha256(`source ${article}`) });
    provenance.newsRevisions.push({ id: `news-revision-${article}`, newsId: `news-${article}`, sourceRevisionId: `source-revision-${article}`, recordHash: h(items.find((row) => row.id === `news-${article}`)) });
    provenance.inputs.push({ id: `input-${article}`, newsRevisionId: `news-revision-${article}`, contentHash: sha256(witness) });
    provenance.evidence.push({ id: `evidence-${article}`, inputId: `input-${article}`, text: witness, firstRange: [0, witness.length] });
    for (const rawEntityId of links[article] ?? []) {
      const observationId = `observation-${article}-${rawEntityId}`;
      provenance.observations.push({ id: observationId, entityId: rawEntityId, newsRevisionId: `news-revision-${article}`, evidenceIds: [`evidence-${article}`] });
      const assertionId = assignedEntityAssertionId(`event-${article}`, rawEntityId);
      provenance.assertions.push({ id: assertionId, subject: `event-${article}`, predicate: "assigned_entity", object: rawEntityId, epistemicScope: "extraction_assignment" });
      provenance.supports.push({ id: `support-${article}-${rawEntityId}`, assertionId, method: "direct_extraction", observationId, prerequisiteIds: [`retention-${rawEntityId}`] });
    }
  }
  for (const id of usedIds) provenance.retention.push({ id: `retention-${id}`, entityId: id, retained: true, revisionId: retentionRevision, observationIds: provenance.observations.filter((row) => row.entityId === id).map((row) => row.id) });
  for (const assertion of provenance.assertions) {
    const row = { assertionId: assertion.id, state: "materialized", supportIds: provenance.supports.filter((support) => support.assertionId === assertion.id).map((support) => support.id).sort() };
    provenance.assertionRevisions.push({ id: `revision-${h(row).slice(0, 24)}`, ...row });
  }
  return { kg: { entities, events, eventRelations: [], entityRelations: [], sources: pages }, news: { pages, news: items }, provenance };
}

function configFor(value, { merged = true } = {}) {
  return { schemaVersion: 1, scope: ENTITY_IDENTITY_SCOPE,
    identities: identityIds.map((id, index) => ({ id, type: "organization", label: `ACME ${index + 1}`, status: "active", reviewedAt: times[0], reason: "Explicitly reviewed identity" })),
    assignments: value.provenance.assertions.map((assertion, index) => {
      const event = value.kg.events.find((row) => row.id === assertion.subject);
      const news = value.news.news.find((row) => row.id === event.newsId);
      return { id: assertion.id, newsId: news.id, rawEntityId: assertion.object, fragmentHash: news.fragment.contentHash,
        inputHash: buildReviewedIdentityInputHash(news), identityId: identityIds[merged ? 0 : index % 2], reviewedAt: times[0], reason: "Explicitly reviewed news assignment" };
    }).sort((a, b) => a.id.localeCompare(b.id)) };
}

function resolved(value, config = configFor(value), previous = null) {
  const result = structuredClone(value);
  const overlay = compileEntityIdentities({ ...result, config, baselineOverlay: previous?.kg.identityResolution?.overlay ?? null });
  result.kg.identityResolution = { schemaVersion: 1, overlay, chronology: { removedIds: [], upserts: [] } };
  return result;
}

function sourcePlan(value, decisions = []) {
  const inventory = Object.fromEntries(value.news.pages.map((row) => [row.repositoryPath, row.contentHash]));
  return { observedInventory: inventory, effectiveInventory: inventory, sourceStates: {}, decisions };
}

function baseline(value, bundleId = A) {
  return { ...value, bundleId, lifecycle: buildCandidateLifecycle({ current: value, sourcePlan: sourcePlan(value) }) };
}

const reviewed = (row, changes, time = times[1]) => ({ ...row, ...changes, reviewedAt: time, reason: "Reviewed explicit correction" });
const identityState = (lifecycle, id = identityIds[0]) => lifecycle.identityResolution.states.identities.find((row) => row.id === id);
const assignmentState = (lifecycle, id) => lifecycle.identityResolution.states.assignments.find((row) => row.id === id);

test("identity lifecycle is optional and old raw lifecycle output stays byte-identical", () => {
  const value = fixture();
  const actual = buildCandidateLifecycle({ current: value, sourcePlan: sourcePlan(value) });
  const summary = summarizeCandidateLifecycleInput(value);
  assert.ok(!Object.hasOwn(actual, "identityResolution"));
  assert.ok(!Object.hasOwn(summary, "identityResolution"));
  // Verified against the pre-feature implementation at 5e1e2bf. Frozen hashes
  // keep this regression independent of Git history availability in shallow CI.
  assert.equal(h(summary), "413ed2ee29e7623bc205d6f24e9d9b942d344febbb432eab9bb84729d13de16c");
  assert.equal(h(actual), "7aabc2ffc7f1a4ec905150182001f41fec1265de8301f4529a2a97730544f789");
  const before = baseline(value);
  const current = fixture({ articles: ["two"] });
  const options = { baseline: before, current, sourcePlan: sourcePlan(current) };
  assert.equal(h(buildCandidateLifecycle(options)), "f4326634a71bb337bd5f2e6d161cdda9b46634c7196a911a5f0ff50f0d65afa8");
});

test("reviewed merge preserves separate per-news raw support and dormant registered identities", () => {
  const value = resolved(fixture());
  const first = baseline(value);
  const resolution = first.lifecycle.identityResolution;
  assert.deepEqual(resolution.initialization, { identities: 2, assignments: 2 });
  assert.deepEqual(resolution.transitions, { identities: [], assignments: [] });
  assert.equal(identityState(first.lifecycle).state, "active");
  assert.equal(identityState(first.lifecycle, identityIds[1]).state, "dormant");
  const rows = resolution.states.assignments;
  assert.ok(rows.every((row) => row.state === "active" && row.identityId === identityIds[0]));
  assert.notEqual(rows[0].newsId, rows[1].newsId);
  assert.notEqual(rows[0].supportRefs[0].recordId, rows[1].supportRefs[0].recordId);
  for (const row of rows) {
    assert.deepEqual(row.rawAssertionRef, reference("self", row.id));
    assert.equal(row.lastActive.rawAssertionRevisionRef.bundleId, "self");
    assert.equal(row.supportRefs[0].bundleId, "self");
  }
  const raw = fixture();
  const rawLifecycle = buildCandidateLifecycle({ current: raw, sourcePlan: sourcePlan(raw) });
  for (const key of ["states", "transitions", "initialization"]) assert.deepEqual(first.lifecycle[key], rawLifecycle[key]);
  assert.match(resolution.semantics, /raw_extraction_supports_remain_separate/u);
});

test("split and explicit clear change reviewed identity history without changing raw ledger transitions", () => {
  const raw = fixture(); const config = configFor(raw); const first = baseline(resolved(raw, config));
  const selected = config.assignments[0].id;
  const splitConfig = structuredClone(config);
  splitConfig.assignments[0] = reviewed(splitConfig.assignments[0], { identityId: identityIds[1] });
  const split = resolved(raw, splitConfig, first);
  const lifecycle = buildCandidateLifecycle({ baseline: first, current: split, sourcePlan: sourcePlan(split) });
  assert.equal(lifecycle.transitions.assertions.length, 0);
  assert.equal(lifecycle.transitions.entities.length, 0);
  assert.equal(lifecycle.transitions.records.summary.changed, 0);
  const change = lifecycle.identityResolution.transitions.assignments.find((row) => row.id === selected);
  assert.equal(change.transition, "reassigned");
  assert.equal(change.fromIdentityId, identityIds[0]);
  assert.equal(change.toIdentityId, identityIds[1]);
  assert.equal(change.supportChanges.survivingCount, 1);
  assert.ok(lifecycle.identityResolution.transitions.identities.some((row) => row.id === identityIds[0]));
  assert.ok(lifecycle.identityResolution.transitions.identities.some((row) => row.id === identityIds[1] && row.transition === "restored"));
  const previous = { ...split, bundleId: B, lifecycle };
  const clearConfig = structuredClone(splitConfig);
  clearConfig.assignments[0] = reviewed(clearConfig.assignments[0], { identityId: null }, times[2]);
  const cleared = resolved(raw, clearConfig, previous);
  const clearLifecycle = buildCandidateLifecycle({ baseline: previous, current: cleared, sourcePlan: sourcePlan(cleared) });
  const state = assignmentState(clearLifecycle, selected);
  assert.equal(state.state, "cleared");
  assert.equal(state.rawState, "active");
  assert.equal(state.identityId, null);
  assert.equal(state.rawAssertionRef.bundleId, "self");
  assert.equal(state.lastActive.recordRef.bundleId, B);
  assert.equal(clearLifecycle.identityResolution.transitions.assignments.find((row) => row.id === selected).transition, "cleared");
});

test("withdrawal carries last-active support references through empty generations and restoration", () => {
  const raw = fixture(); const config = configFor(raw); const first = baseline(resolved(raw, config));
  const empty = resolved(fixture({ articles: [] }), config, first);
  const decisions = [{ path: "daily/one.md", operation: "retract" }, { path: "daily/two.md", operation: "retract" }];
  const lifecycle = buildCandidateLifecycle({ baseline: first, current: empty, sourcePlan: sourcePlan(empty, decisions) });
  for (const state of lifecycle.identityResolution.states.assignments) {
    assert.equal(state.state, "dormant");
    assert.equal(state.rawAssertionRef, null);
    assert.deepEqual(state.supportRefs, []);
    assert.equal(state.lastActive.rawAssertionRef.bundleId, A);
    assert.equal(state.lastActive.supportRefs[0].bundleId, A);
    assert.equal(state.sourcePaths.length, 1);
  }
  assert.ok(lifecycle.identityResolution.transitions.assignments.every((row) => row.transition === "deactivated" && row.supportChanges.currentCount === 0 && row.sourceDecisionPaths.length === 1));
  const second = { ...empty, bundleId: B, lifecycle };
  const carried = buildCandidateLifecycle({ baseline: second, current: empty, sourcePlan: sourcePlan(empty) });
  assert.equal(carried.identityResolution.transitions.assignments.length, 0);
  assert.ok(carried.identityResolution.states.assignments.every((row) => row.lastActive.supportRefs[0].bundleId === A));
  assert.ok(carried.referencedBundleIds.includes(A));
  const third = { ...empty, bundleId: C, lifecycle: carried };
  const restored = resolved(raw, config, third);
  const result = buildCandidateLifecycle({ baseline: third, current: restored, sourcePlan: sourcePlan(restored) });
  assert.ok(result.identityResolution.transitions.assignments.every((row) => row.transition === "restored" && row.beforeRawAssertionRevision.bundleId === A));
  assert.ok(result.identityResolution.states.assignments.every((row) => row.lastActive.supportRefs[0].bundleId === "self"));
});

test("registered tombstones are distinct from unsupported identities and can be reviewed back to active", () => {
  const raw = fixture(); const config = configFor(raw); const first = baseline(resolved(raw, config));
  const tombstoneConfig = structuredClone(config);
  tombstoneConfig.identities[1] = reviewed(tombstoneConfig.identities[1], { status: "tombstoned" });
  const tombstoned = resolved(raw, tombstoneConfig, first);
  const lifecycle = buildCandidateLifecycle({ baseline: first, current: tombstoned, sourcePlan: sourcePlan(tombstoned) });
  assert.equal(identityState(lifecycle, identityIds[1]).state, "tombstoned");
  assert.equal(identityState(lifecycle, identityIds[1]).registrationStatus, "tombstoned");
  assert.equal(lifecycle.identityResolution.transitions.identities.find((row) => row.id === identityIds[1]).transition, "tombstoned");
  const previous = { ...tombstoned, bundleId: B, lifecycle };
  const restoreConfig = structuredClone(tombstoneConfig);
  restoreConfig.identities[1] = reviewed(restoreConfig.identities[1], { status: "active" }, times[2]);
  const restored = resolved(raw, restoreConfig, previous);
  const next = buildCandidateLifecycle({ baseline: previous, current: restored, sourcePlan: sourcePlan(restored) });
  assert.equal(identityState(next, identityIds[1]).state, "dormant");
  assert.equal(identityState(next, identityIds[1]).registrationStatus, "active");
  assert.equal(next.identityResolution.transitions.identities.find((row) => row.id === identityIds[1]).transition, "restored");
});

test("global retention disappearance and revised raw prerequisites stay attributable", () => {
  const raw = fixture(); const config = configFor(raw); const first = baseline(resolved(raw, config));
  const disappeared = resolved(fixture({ links: { one: [], two: [] } }), config, first);
  const lifecycle = buildCandidateLifecycle({ baseline: first, current: disappeared, sourcePlan: sourcePlan(disappeared) });
  assert.ok(lifecycle.states.news.every((row) => row.state === "active"));
  assert.ok(lifecycle.identityResolution.states.assignments.every((row) => row.state === "dormant"));
  const revised = resolved(fixture({ retentionRevision: "retention-v2" }), config, first);
  const revisionLifecycle = buildCandidateLifecycle({ baseline: first, current: revised, sourcePlan: sourcePlan(revised) });
  assert.ok(revisionLifecycle.identityResolution.transitions.assignments.every((row) => row.transition === "changed" && row.supportChanges.changed.length === 1 && row.supportChanges.survivingCount === 0));
  assert.deepEqual(revisionLifecycle.identityResolution.states.assignments.map((row) => row.id), first.lifecycle.identityResolution.states.assignments.map((row) => row.id));
});

test("compact identity summaries are equivalent, order-independent and omit witness text", () => {
  const raw = fixture({ witness: "ACME ".repeat(10000) }); const value = resolved(raw);
  const summary = summarizeCandidateLifecycleInput(value);
  assert.ok(!canonicalJson(summary).includes("ACME ACME"));
  assert.ok(canonicalJson(summary).length < canonicalJson(value.provenance).length / 2);
  const first = baseline(value);
  const current = resolved(fixture({ retentionRevision: "next" }), configFor(raw), first);
  const options = { baseline: first, current, sourcePlan: sourcePlan(current) };
  assert.deepEqual(buildCandidateLifecycle(options), buildCandidateLifecycle({ ...options,
    baseline: { bundleId: A, summary, lifecycle: first.lifecycle }, current: { summary: summarizeCandidateLifecycleInput(current) } }));
  const permuted = structuredClone(value);
  for (const object of [permuted.kg, permuted.news, permuted.provenance, permuted.kg.identityResolution.overlay]) for (const rows of Object.values(object)) if (Array.isArray(rows)) rows.reverse();
  assert.deepEqual(summarizeCandidateLifecycleInput(permuted), summary);
});

test("identity overlay and lifecycle tampering fail reconstruction without creating authority", () => {
  const value = resolved(fixture()); const first = baseline(value);
  for (const corrupt of [
    (row) => { row.kg.identityResolution = null; },
    (row) => { row.kg.identityResolution.overlay.assignments[0].supportIds = ["forged"]; },
    (row) => { row.kg.identityResolution.overlay.assignments[0].state = "dormant"; },
    (row) => { row.kg.identityResolution.overlay.assignments[0].newsId = "news-invented"; },
    (row) => { row.kg.identityResolution.overlay.assignments[0].inputHash = sha256("forged input"); },
    (row) => { row.kg.identityResolution.overlay.identities[0].type = "topic"; },
    (row) => { row.kg.identityResolution.overlay.configHash = sha256("forged config"); },
  ]) {
    const forged = structuredClone(value); corrupt(forged);
    assert.throws(() => summarizeCandidateLifecycleInput(forged));
  }
  const options = { baseline: first, current: value, sourcePlan: sourcePlan(value) };
  const expected = buildCandidateLifecycle(options);
  for (const corrupt of [
    (row) => { row.identityResolution.states.assignments[0].identityId = identityIds[1]; },
    (row) => { row.identityResolution.states.assignments[0].supportRefs[0].bundleId = A; },
    (row) => { row.identityResolution.states.identities[0].state = "tombstoned"; },
    (row) => { row.identityResolution.transitions.assignments.push({ id: "invented" }); },
    (row) => { delete row.identityResolution; },
  ]) {
    const forged = structuredClone(expected); corrupt(forged);
    assert.equal(validateCandidateLifecycle(forged, options).length, 1);
  }
  const poisoned = structuredClone(first);
  poisoned.lifecycle.identityResolution.states.assignments[0].identityId = identityIds[1];
  poisoned.lifecycle.identityResolution.states.identities.push({ id: "invented", state: "active" });
  assert.deepEqual(buildCandidateLifecycle({ ...options, baseline: poisoned }), expected, "stored active claims do not replace verified snapshot rows");
  assert.throws(() => buildCandidateLifecycle({ baseline: first, current: fixture(), sourcePlan: sourcePlan(value) }), /overlay cannot be dropped/u);
});

test("reviewed dormant history is bounded by known identities rather than generation count", () => {
  const raw = fixture(); const config = configFor(raw); const first = baseline(resolved(raw, config));
  const empty = resolved(fixture({ articles: [] }), config, first);
  let previous = { ...empty, bundleId: B, lifecycle: buildCandidateLifecycle({ baseline: first, current: empty, sourcePlan: sourcePlan(empty) }) };
  const states = canonicalJson(previous.lifecycle.identityResolution.states);
  for (let index = 0; index < 12; index += 1) {
    const lifecycle = buildCandidateLifecycle({ baseline: previous, current: empty, sourcePlan: sourcePlan(empty) });
    assert.equal(canonicalJson(lifecycle.identityResolution.states), states);
    assert.deepEqual(lifecycle.identityResolution.transitions, { identities: [], assignments: [] });
    assert.ok(lifecycle.referencedBundleIds.length <= 2);
    previous = { ...empty, bundleId: sha256(`empty generation ${index}`), lifecycle };
  }
});
