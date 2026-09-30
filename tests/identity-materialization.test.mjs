import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { buildChronologyRelations } from "../scripts/lib/kg-build.mjs";
import { assignedEntityAssertionId, buildReviewedIdentityInputHash } from "../scripts/lib/entity-identities.mjs";
import { attachIdentityResolution, identityDiff, validateIdentityResolution, validateIdentityRendering } from "../scripts/lib/identity-materialization.mjs";
import { createEventSearchDocument, parseSearchQuery, matchesSearchDocument } from "../app/lib/search.mjs";
import { applyIdentityResolution } from "../app/lib/identity-projection.mjs";

const at = "2026-01-01T00:00:00Z";
function fixture(members = ["a", "b", "a"], type = "person", dates = []) {
  const entities = [...new Set(members)].map((id) => ({ id: `raw-${id}`, type, label: id, aliases: [], description: "Raw extraction" }));
  const news = members.map((_, index) => ({ id: `news-${index}`, title: `Item ${index}`, summary: "Reviewed source context", fragment: { contentHash: sha256(`fragment-${index}`) } }));
  const events = members.map((id, index) => ({ id: `event-${index}`, newsId: news[index].id, title: news[index].title, summary: news[index].summary, type: "other", date: dates[index] ?? new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10), entityIds: [`raw-${id}`], sourceIds: [`source-${index}`], topicEvidence: [] }));
  const kg = { entities, events, eventRelations: buildChronologyRelations(events, entities), entityRelations: [], sources: [] };
  const provenance = { epistemicScope: "extraction_assignment", assertions: [], supports: [], observations: [], newsRevisions: [], assertionRevisions: [] };
  for (const event of events) {
    const revision = `revision-${event.newsId}`; const id = assignedEntityAssertionId(event.id, event.entityIds[0]); const supportId = `support-${id}`;
    provenance.newsRevisions.push({ id: revision, newsId: event.newsId });
    provenance.assertions.push({ id, subject: event.id, predicate: "assigned_entity", object: event.entityIds[0], epistemicScope: "extraction_assignment" });
    provenance.supports.push({ id: supportId, assertionId: id, method: "global_name_rescan", newsRevisionId: revision });
    provenance.assertionRevisions.push({ id: `revision-${id}`, assertionId: id, state: "materialized", supportIds: [supportId] });
  }
  const config = { schemaVersion: 1, scope: "news_scoped_extraction_assignment", identities: [{ id: "identity-subject", type, label: "Reviewed subject", status: "active", reason: "Fixture selected-source identity review", reviewedAt: at }], assignments: events.map((event, index) => ({ id: assignedEntityAssertionId(event.id, event.entityIds[0]), newsId: event.newsId, rawEntityId: event.entityIds[0], fragmentHash: news[index].fragment.contentHash, inputHash: buildReviewedIdentityInputHash(news[index]), identityId: "identity-subject", reason: "Explicit assignment review", reviewedAt: at })) };
  return { kg, news: { news }, provenance, config };
}

test("reviewed merge fully recomputes middle chronology and retains raw extraction bytes", () => {
  const input = fixture(); const before = canonicalJson(input);
  const kg = attachIdentityResolution(input); const view = applyIdentityResolution(kg);
  assert.deepEqual(view.eventRelations.map((row) => [row.from, row.to]), [["event-0", "event-1"], ["event-1", "event-2"]]);
  assert.equal(kg.identityResolution.chronology.removedIds.length, 1);
  for (const relation of view.eventRelations) {
    assert.equal(relation.identityDerivation.kind, "reviewed_news_identity_date_order");
    for (const id of [...relation.identityDerivation.fromAssignmentIds, ...relation.identityDerivation.toAssignmentIds]) assert.ok(input.provenance.assertions.some((row) => row.id === id));
  }
  assert.equal(canonicalJson(input), before);
  assert.deepEqual(validateIdentityResolution({ ...input, kg }), []);
  assert.deepEqual(validateIdentityRendering({ ...input, kg }), []);
  assert.equal(identityDiff(input.kg, kg).identity.registry.summary.added, 4);
});

test("splitting selected news breaks raw chronology and joins only reviewed matching identities", () => {
  const input = fixture(["a", "a", "a"]);
  input.config.identities.push({ ...input.config.identities[0], id: "identity-other" });
  input.config.assignments[1].identityId = "identity-other";
  const view = applyIdentityResolution(attachIdentityResolution(input));
  assert.deepEqual(view.eventRelations.map((row) => [row.from, row.to]), [["event-0", "event-2"]]);
});

for (const [type, limit] of [["place", 90], ["person", 250]]) {
  test(`resolved ${type} chronology recomputes the ${limit} mention cap after merging`, () => {
    const members = Array.from({ length: limit + 1 }, (_, index) => index % 2 ? "a" : "b");
    const input = fixture(members, type);
    assert.ok(input.kg.eventRelations.length > 0);
    assert.equal(applyIdentityResolution(attachIdentityResolution(input)).eventRelations.length, 0);
    const boundary = fixture(members.slice(0, limit), type);
    assert.equal(applyIdentityResolution(attachIdentityResolution(boundary)).eventRelations.length, limit - 1);
  });
}

test("identity chronology excludes unknown dates and does not order equal-date news", () => {
  const input = fixture(["a", "b", "a", "b"], "person", ["2025-01-01", "2025-01-01", "1900-01-01", "2025-01-03"]);
  const relations = applyIdentityResolution(attachIdentityResolution(input)).eventRelations;
  assert.deepEqual(relations.map((row) => [row.from, row.to]), [["event-1", "event-3"]]);
});

test("forged overlay, chronology, supports and missing output fail independent identity replay", () => {
  const input = fixture(); const kg = attachIdentityResolution(input);
  for (const corrupt of [
    (value) => { value.identityResolution.overlay.configHash = sha256("other"); },
    (value) => { value.identityResolution.overlay.assignments[0].supportIds = []; },
    (value) => { value.identityResolution.chronology.upserts.pop(); },
    (value) => { value.identityResolution.chronology.removedIds = []; },
    (value) => { delete value.identityResolution; },
  ]) {
    const changed = structuredClone(kg); corrupt(changed);
    assert.ok(validateIdentityResolution({ ...input, kg: changed }).length);
    assert.ok(validateIdentityRendering({ ...input, kg: changed }).length);
  }
});

test("a deliberately empty registry preserves legacy graph bytes; a used registry cannot disappear", () => {
  const input = fixture(); const config = { ...input.config, identities: [], assignments: [] };
  assert.deepEqual(attachIdentityResolution({ ...input, config }), input.kg);
  const baselineOverlay = attachIdentityResolution(input).identityResolution.overlay;
  assert.throws(() => attachIdentityResolution({ ...input, config: null, baselineOverlay }), /cannot be removed/u);
});

test("resolved search preserves per-news raw names without promoting them to global aliases", () => {
  const input = fixture(["originalalpha", "originalbeta", "originalalpha"]);
  input.config.identities.push({ ...input.config.identities[0], id: "identity-other", label: "Other reviewed subject" });
  input.config.assignments[2].identityId = "identity-other";
  const view = applyIdentityResolution(attachIdentityResolution(input));
  const documents = view.events.map((event) => createEventSearchDocument({ event, entities: view.entities.filter((entity) => event.entityIds.includes(entity.id)) }));
  assert.equal(matchesSearchDocument(documents[0], parseSearchQuery("originalalpha")), true);
  assert.equal(matchesSearchDocument(documents[1], parseSearchQuery("originalalpha")), false);
  assert.equal(matchesSearchDocument(documents[2], parseSearchQuery("originalalpha")), true);
  assert.deepEqual(view.entities.map((row) => row.aliases), [[], []]);
  const previousRaw = view.identityNavigation.find((row) => row.rawEntityId === "raw-originalalpha");
  assert.equal(previousRaw.targets.length, 2);
  assert.deepEqual(previousRaw.targets.map((row) => row.newsCount), [1, 1]);
  assert.equal(view.entities.find((row) => row.id === "identity-subject").identityResolution.newsCount, 2);
});

test("withdrawn raw IDs and inactive reviewed IDs retain explicit historical navigation", () => {
  const input = fixture(["a", "b"]);
  const baseline = attachIdentityResolution(input);
  const current = structuredClone(input);
  current.kg.events.shift(); current.kg.entities.shift(); current.news.news.shift(); current.provenance.newsRevisions.shift();
  const removed = assignedEntityAssertionId("event-0", "raw-a");
  current.provenance.assertions = current.provenance.assertions.filter((row) => row.id !== removed);
  current.provenance.supports = current.provenance.supports.filter((row) => row.assertionId !== removed);
  current.provenance.assertionRevisions = current.provenance.assertionRevisions.filter((row) => row.assertionId !== removed);
  const view = applyIdentityResolution(attachIdentityResolution({ ...current, baselineOverlay: baseline.identityResolution.overlay }));
  const historical = view.identityNavigation.find((row) => row.rawEntityId === "raw-a");
  assert.equal(historical.state, "dormant"); assert.equal(historical.targets[0].id, "identity-subject"); assert.equal(historical.targets[0].newsCount, 0);
  const cleared = structuredClone(input);
  for (const row of cleared.config.assignments) { row.identityId = null; row.reviewedAt = "2026-02-01T00:00:00Z"; }
  cleared.config.identities[0].status = "tombstoned"; cleared.config.identities[0].reviewedAt = "2026-02-01T00:00:00Z";
  const retired = applyIdentityResolution(attachIdentityResolution({ ...cleared, baselineOverlay: baseline.identityResolution.overlay }));
  assert.equal(retired.identityRegistrations[0].state, "tombstoned");
  assert.equal(retired.identityNavigation.find((row) => row.rawEntityId === "raw-a").state, "cleared");
  assert.ok(!retired.entities.some((row) => row.id === "identity-subject"));
});
