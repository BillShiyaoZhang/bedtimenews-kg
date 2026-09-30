import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { parseSourcePage } from "../scripts/lib/news.mjs";
import { buildKnowledgeGraph } from "../scripts/lib/kg-build.mjs";
import { buildCandidateProvenance } from "../scripts/lib/candidate-provenance.mjs";
import { ENTITY_IDENTITY_SCOPE, entityIdentitiesConfigHash, applyIdentityResolution, assignedEntityAssertionId, buildReviewedIdentityInputHash, compileEntityIdentities, validateEntityIdentities, validateEntityIdentityOverlay, projectIdentityEntities, materializeIdentityGraph } from "../scripts/lib/entity-identities.mjs";
import { projectIdentityEntities as browserProject } from "../app/lib/identity-projection.mjs";

const AT = "2026-01-01T00:00:00Z";
const LATER = "2026-02-01T00:00:00Z";
const LAST = "2026-03-01T00:00:00Z";
const clone = (value) => structuredClone(value);
const identity = (id, label = id, type = "person") => ({ id, type, label, status: "active", reason: "Reviewed the named subject in each selected news item", reviewedAt: AT });
const emptyConfig = () => ({ schemaVersion: 1, scope: ENTITY_IDENTITY_SCOPE, identities: [], assignments: [] });

function fixture() {
  const entity = (id, label, type = "person") => ({ id, label, type, aliases: [], description: "Original extraction description", extraction: { method: "role_after", confidence: 0.8, eventCount: 2 } });
  const entities = [entity("raw-a", "张伟"), entity("raw-b", "张主任"), entity("raw-topic", "科技", "topic")];
  const news = [1, 2, 3].map((n) => ({ id: `news-${n}`, pageId: `source-${n}`, title: `张伟的报道 ${n}`, summary: "姓名相同不证明身份相同", date: `2026-01-0${n}`, fragment: { contentHash: sha256(`fragment-${n}`) } }));
  const events = news.map((item, index) => ({ id: `event-${index + 1}`, newsId: item.id, title: item.title, summary: item.summary, date: item.date, datePrecision: "day", type: "science", sourceIds: [item.pageId], entityIds: index === 0 ? ["raw-a", "raw-b", "raw-topic"] : index === 1 ? ["raw-a", "raw-topic"] : ["raw-b"], topicEvidence: index < 2 ? [{ entityId: "raw-topic", terms: ["科技"] }] : [], significance: "" }));
  const kg = { schemaVersion: "2.3.0", generatedAt: AT, source: { extractionVersion: "fixture-v1" }, entities, events, eventRelations: [], entityRelations: [], sources: news.map((item) => ({ id: item.pageId })) };
  const provenance = { epistemicScope: "extraction_assignment", assertions: [], supports: [], observations: [], newsRevisions: [], assertionRevisions: [] };
  for (const event of events) {
    const revisionId = `news-revision-${event.newsId}`;
    provenance.newsRevisions.push({ id: revisionId, newsId: event.newsId });
    for (const rawEntityId of event.entityIds) {
      const id = assignedEntityAssertionId(event.id, rawEntityId);
      const observationId = `observation-${id}`;
      const supportIds = [`support-direct-${id}`, `support-rescan-${id}`];
      provenance.assertions.push({ id, subject: event.id, predicate: "assigned_entity", object: rawEntityId, epistemicScope: "extraction_assignment" });
      provenance.observations.push({ id: observationId, newsRevisionId: revisionId, entityId: rawEntityId });
      provenance.supports.push({ id: supportIds[0], assertionId: id, method: "direct_extraction", observationId }, { id: supportIds[1], assertionId: id, method: "global_name_rescan", newsRevisionId: revisionId });
      provenance.assertionRevisions.push({ id: `revision-${id}`, assertionId: id, state: "materialized", supportIds });
    }
  }
  return { kg, news: { news }, provenance };
}

function assignment(input, newsId, rawEntityId, identityId) {
  const item = input.news.news.find((row) => row.id === newsId);
  const event = input.kg.events.find((row) => row.newsId === newsId);
  return { id: assignedEntityAssertionId(event.id, rawEntityId), newsId, rawEntityId, fragmentHash: item.fragment.contentHash, inputHash: buildReviewedIdentityInputHash(item), identityId, reason: "Reviewed this independent news-scoped assignment", reviewedAt: AT };
}

function merged(input = fixture()) {
  const config = { ...emptyConfig(), identities: [identity("identity-1", "张伟（已核实的主体）")], assignments: [assignment(input, "news-1", "raw-a", "identity-1"), assignment(input, "news-1", "raw-b", "identity-1"), assignment(input, "news-3", "raw-b", "identity-1")] };
  return { ...input, config };
}

function removeAssignments(input, predicate) {
  const result = clone(input);
  const removed = new Set(result.provenance.assertions.filter(predicate).map((row) => row.id));
  result.provenance.assertions = result.provenance.assertions.filter((row) => !removed.has(row.id));
  result.provenance.supports = result.provenance.supports.filter((row) => !removed.has(row.assertionId));
  result.provenance.assertionRevisions = result.provenance.assertionRevisions.filter((row) => !removed.has(row.assertionId));
  const activeObservationIds = new Set(result.provenance.supports.map((row) => row.observationId));
  result.provenance.observations = result.provenance.observations.filter((row) => activeObservationIds.has(row.id));
  for (const event of result.kg.events) event.entityIds = event.entityIds.filter((id) => !removed.has(assignedEntityAssertionId(event.id, id)));
  const liveEntityIds = new Set(result.kg.events.flatMap((event) => event.entityIds));
  result.kg.entities = result.kg.entities.filter((row) => liveEntityIds.has(row.id));
  return result;
}

function withdraw(input, newsId) {
  const event = input.kg.events.find((row) => row.newsId === newsId);
  const result = removeAssignments(input, (row) => row.subject === event.id);
  result.kg.events = result.kg.events.filter((row) => row.id !== event.id);
  result.news.news = result.news.news.filter((row) => row.id !== newsId);
  result.provenance.newsRevisions = result.provenance.newsRevisions.filter((row) => row.newsId !== newsId);
  return result;
}

function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test("empty registry preserves exact raw graph projection and mutates nothing", () => {
  const input = fixture(); const before = canonicalJson(input);
  const config = emptyConfig(); freeze(input); freeze(config);
  const overlay = compileEntityIdentities({ ...input, config });
  assert.deepEqual(projectIdentityEntities(input.kg, overlay), { entities: input.kg.entities, events: input.kg.events });
  assert.deepEqual(materializeIdentityGraph(input.kg, overlay), input.kg);
  assert.equal(canonicalJson(input), before);
  assert.deepEqual(validateEntityIdentityOverlay(overlay, { ...input, config }), []);
});

test("reviewed merge preserves distinct raw assignments and every exact support pointer", () => {
  const input = merged(); const before = canonicalJson(input); freeze(input);
  const overlay = compileEntityIdentities(input);
  assert.deepEqual(overlay, compileEntityIdentities(input));
  const projection = projectIdentityEntities(input.kg, overlay);
  assert.equal(browserProject, projectIdentityEntities);
  assert.deepEqual(projection.events[0].entityIds, ["identity-1", "raw-topic"]);
  assert.deepEqual(projection.events[1].entityIds, ["raw-a", "raw-topic"]);
  assert.deepEqual(projection.events[2].entityIds, ["identity-1"]);
  assert.deepEqual(projection.entities.map((row) => row.id), ["raw-a", "raw-topic", "identity-1"]);
  assert.equal(projection.entities.find((row) => row.id === "raw-a").extraction.eventCount, 1);
  assert.deepEqual(projection.entities.find((row) => row.id === "identity-1").aliases, []);
  assert.equal(overlay.assignments.filter((row) => row.newsId === "news-1").length, 2);
  for (const row of overlay.assignments) {
    const expected = input.provenance.supports.filter((support) => support.assertionId === row.id).map((support) => support.id).sort();
    assert.deepEqual(row.supportIds, expected);
    assert.equal(row.state, "active");
  }
  assert.match(overlay.independence, /not_independent_source_counts/u);
  assert.equal(canonicalJson(input), before);
  assert.deepEqual(projection.events.map((row) => row.topicEvidence), input.kg.events.map((row) => row.topicEvidence));
});

test("split and reviewed reversal alter only selected per-news targets", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  const config = clone(input.config); config.identities.push(identity("identity-2", "另一个张伟"));
  const selected = config.assignments.find((row) => row.newsId === "news-3"); selected.identityId = "identity-2"; selected.reviewedAt = LATER;
  const split = compileEntityIdentities({ ...input, config, baselineOverlay });
  assert.equal(projectIdentityEntities(input.kg, split).events[2].entityIds[0], "identity-2");
  assert.equal(projectIdentityEntities(input.kg, split).events[0].entityIds[0], "identity-1");
  selected.identityId = null; selected.reviewedAt = LAST;
  const reversed = compileEntityIdentities({ ...input, config, baselineOverlay: split });
  assert.deepEqual(projectIdentityEntities(input.kg, reversed).events[2].entityIds, ["raw-b"]);
  assert.equal(reversed.assignments.length, baselineOverlay.assignments.length);
  assert.deepEqual(reversed.identities.map((row) => row.id), ["identity-1", "identity-2"]);
});

test("same label is ambiguous; no unreviewed future assignment inherits an identity", () => {
  const input = merged();
  input.config.identities.push(identity("identity-2", input.config.identities[0].label));
  input.config.assignments.push(assignment(input, "news-2", "raw-a", "identity-2"));
  const overlay = compileEntityIdentities(input);
  assert.equal(projectIdentityEntities(input.kg, overlay).events[1].entityIds[0], "identity-2");
  const withoutReview = clone(input.config); withoutReview.assignments.pop();
  const raw = projectIdentityEntities(input.kg, compileEntityIdentities({ ...input, config: withoutReview }));
  assert.equal(raw.events[1].entityIds[0], "raw-a");
});

test("source withdrawal keeps dormant history; restoration of exact news reactivates", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  const withdrawn = withdraw(input, "news-1");
  const dormant = compileEntityIdentities({ ...withdrawn, baselineOverlay });
  const removedRows = dormant.assignments.filter((row) => row.newsId === "news-1");
  assert.equal(removedRows.length, 2);
  assert.ok(removedRows.every((row) => row.state === "dormant" && row.supportIds.length === 0));
  assert.deepEqual(dormant.identities, baselineOverlay.identities);
  assert.deepEqual(compileEntityIdentities({ ...input, baselineOverlay: dormant }), baselineOverlay);
  assert.throws(() => compileEntityIdentities(withdrawn), /unknown or changed dormant assignment/u);
});

test("global retention disappearance is dormant despite surviving unchanged news", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  const unretained = removeAssignments(input, (row) => row.object === "raw-b");
  const dormant = compileEntityIdentities({ ...unretained, baselineOverlay });
  assert.ok(dormant.assignments.filter((row) => row.rawEntityId === "raw-b").every((row) => row.state === "dormant"));
  assert.deepEqual(compileEntityIdentities({ ...input, baselineOverlay: dormant }), baselineOverlay);
});

test("missing reviewed link to a still-retained entity fails closed until explicitly cleared", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  const changed = removeAssignments(input, (row) => row.subject === "event-1" && row.object === "raw-a");
  assert.throws(() => compileEntityIdentities({ ...changed, baselineOverlay }), /disappeared from a retained entity/u);
  const decision = changed.config.assignments.find((row) => row.rawEntityId === "raw-a"); decision.identityId = null; decision.reviewedAt = LATER;
  const cleared = compileEntityIdentities({ ...changed, baselineOverlay });
  assert.equal(cleared.assignments.find((row) => row.id === decision.id).state, "dormant");
  assert.ok(!projectIdentityEntities(changed.kg, cleared).events[0].entityIds.includes("raw-a"));
});

test("unknown dormant reviews, altered dormant pins, and deleted historic anchors fail", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  const removed = withdraw(input, "news-1");
  for (const field of ["fragmentHash", "inputHash"]) {
    const changed = clone(removed); changed.config.assignments[0][field] = sha256(field); changed.config.assignments[0].reviewedAt = LATER;
    assert.throws(() => compileEntityIdentities({ ...changed, baselineOverlay }), /unknown or changed dormant assignment/u);
  }
  for (const collection of ["identities", "assignments"]) {
    const changed = clone(input); changed.config[collection].pop();
    assert.throws(() => compileEntityIdentities({ ...changed, baselineOverlay }), /unknown identity target|cannot be removed or reused/u);
  }
});

test("fragment, title and summary edits require a newly pinned reviewed update", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  for (const field of ["fragment", "title", "summary"]) {
    const changed = clone(input); const item = changed.news.news[0];
    if (field === "fragment") item.fragment.contentHash = sha256("changed fragment"); else item[field] += " changed";
    assert.throws(() => compileEntityIdentities({ ...changed, baselineOverlay }), /reviewed news input changed/u);
    for (const row of changed.config.assignments.filter((row) => row.newsId === item.id)) { row.fragmentHash = item.fragment.contentHash; row.inputHash = buildReviewedIdentityInputHash(item); row.reviewedAt = LATER; }
    assert.ok(compileEntityIdentities({ ...changed, baselineOverlay }).assignments.every((row) => row.state === "active"));
  }
});

test("date reconciliation and changing support sets do not invalidate reviewed inputs", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  const changed = clone(input); changed.news.news[0].date = "2026-07-01"; changed.news.news[0].pageId = "a-new-page-metadata-value";
  const selected = changed.provenance.supports.find((row) => row.method === "global_name_rescan");
  changed.provenance.supports = changed.provenance.supports.filter((row) => row.id !== selected.id);
  changed.provenance.assertionRevisions.find((row) => row.assertionId === selected.assertionId).supportIds = changed.provenance.assertionRevisions.find((row) => row.assertionId === selected.assertionId).supportIds.filter((id) => id !== selected.id);
  const next = compileEntityIdentities({ ...changed, baselineOverlay });
  assert.equal(next.assignments.find((row) => row.id === selected.assertionId).supportIds.length, 1);
  assert.equal(next.assignments.find((row) => row.id === selected.assertionId).inputHash, baselineOverlay.assignments.find((row) => row.id === selected.assertionId).inputHash);
});

test("tombstoned targets cannot materialize and dormant history survives their tombstone", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  const config = clone(input.config); config.identities[0].status = "tombstoned"; config.identities[0].reviewedAt = LATER;
  assert.throws(() => compileEntityIdentities({ ...input, config, baselineOverlay }), /targets tombstoned identity/u);
  const removed = removeAssignments(input, (row) => ["raw-a", "raw-b"].includes(row.object));
  const dormant = compileEntityIdentities({ ...removed, config, baselineOverlay });
  assert.ok(dormant.assignments.every((row) => row.state === "dormant"));
  assert.throws(() => compileEntityIdentities({ ...input, config, baselineOverlay: dormant }), /targets tombstoned identity/u);
});

test("topics, wrong types, unknown targets, ID reuse and redirection fields are rejected", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  for (const mutate of [
    (value) => { value.config.identities[0].type = "topic"; },
    (value) => { value.config.identities[0].type = "organization"; },
    (value) => { value.config.assignments[0].identityId = "unknown"; },
    (value) => { value.config.identities[0].redirectTo = "identity-2"; },
    (value) => { value.config.assignments[0].rawEntityId = "raw-b"; },
    (value) => { value.config.assignments[0] = assignment(value, "news-1", "raw-topic", "identity-1"); },
    (value) => { value.config.identities[0].type = "unrecognized"; },
  ]) { const changed = clone(input); mutate(changed); assert.throws(() => compileEntityIdentities({ ...changed, baselineOverlay })); }
  const cycle = clone(input); cycle.config.identities.push(identity("identity-2")); cycle.config.identities[0].redirectTo = "identity-2"; cycle.config.identities[1].redirectTo = "identity-1";
  assert.throws(() => validateEntityIdentities(cycle.config), /unknown fields/u);
});

test("one news/raw assignment cannot select two identities or claim token-level scope", () => {
  const input = merged(); input.config.identities.push(identity("identity-2"));
  const duplicate = clone(input.config.assignments[0]); duplicate.id = `assertion-${"f".repeat(24)}`; duplicate.identityId = "identity-2";
  input.config.assignments.push(duplicate);
  assert.throws(() => compileEntityIdentities(input), /duplicate news\/raw entity/u);
  input.config.assignments.pop(); input.config.assignments[0].span = [0, 2];
  assert.throws(() => compileEntityIdentities(input), /unknown fields/u);
});

test("review metadata has strict calendar timestamps and semantic changes need later review", () => {
  const input = merged(); const baselineOverlay = compileEntityIdentities(input);
  const config = clone(input.config); config.assignments[0].identityId = null;
  assert.throws(() => compileEntityIdentities({ ...input, config, baselineOverlay }), /later explicit review/u);
  for (const reviewedAt of ["2026-02-30T00:00:00Z", "2026-01-01", "2026-01-01T24:00:00Z"]) { const invalid = clone(input.config); invalid.identities[0].reviewedAt = reviewedAt; assert.throws(() => validateEntityIdentities(invalid), /invalid identity/u); }
});

test("raw provenance remains the authority and cross-news supports are rejected", () => {
  const input = merged(); const selected = input.provenance.supports.find((row) => row.method === "global_name_rescan");
  selected.newsRevisionId = "news-revision-news-2";
  assert.throws(() => compileEntityIdentities(input), /cross-news assignment support/u);
  const other = merged(); other.provenance.assertionRevisions[0].supportIds.pop();
  assert.throws(() => compileEntityIdentities(other), /invalid raw assignment support set/u);
  const badId = merged(); badId.provenance.assertions[0].id = "forged";
  assert.throws(() => compileEntityIdentities(badId), /unknown assertion/u);
});

test("replay rejects forged support IDs, missing rows, unknown fields and target changes", () => {
  const input = merged(); const overlay = compileEntityIdentities(input);
  for (const mutate of [
    (value) => { value.assignments[0].supportIds.pop(); },
    (value) => { value.assignments.pop(); },
    (value) => { value.unreviewed = true; },
    (value) => { value.assignments[0].identityId = null; },
    (value) => { value.identities[0].label = "different"; },
  ]) { const changed = clone(overlay); mutate(changed); assert.equal(validateEntityIdentityOverlay(changed, input).length, 1); }
});

test("resolved graph refuses stale chronology and validates explicitly recomputed relation endpoints", () => {
  const input = merged(); const overlay = compileEntityIdentities(input);
  assert.throws(() => materializeIdentityGraph(input.kg, overlay), /chronology must be recomputed/u);
  const relation = { id: "resolved-1", from: "event-1", to: "event-3", type: "precedes", viaEntityId: "identity-1", evidence: "Reviewed identity date order", confidence: 1, sourceId: "source-3" };
  const resolved = materializeIdentityGraph(input.kg, overlay, { eventRelations: [relation] });
  assert.deepEqual(resolved.eventRelations, [relation]);
  assert.equal(resolved.identityResolution, undefined);
  assert.throws(() => materializeIdentityGraph(input.kg, overlay, { eventRelations: [{ ...relation, viaEntityId: "raw-b" }] }), /invalid resolved chronology identity/u);
  assert.throws(() => materializeIdentityGraph(input.kg, overlay, { eventRelations: [{ ...relation, from: "event-3", to: "event-1" }] }), /chronology endpoints/u);
  const withRelations = clone(input.kg); withRelations.entityRelations = [{ id: "unsupported" }];
  assert.throws(() => materializeIdentityGraph(withRelations, overlay, { eventRelations: [] }), /entity relations require/u);
});

test("real extraction assertion IDs and mixed direct/rescan support references agree exactly", async () => {
  const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  const [ontology, rules, template] = await Promise.all(["../data/ontology.json", "../data/extraction-rules.json", "../data/processed/news.json"].map(read));
  const pages = []; const news = []; const rawPages = new Map(); const sourceInventory = {};
  for (let day = 1; day <= 2; day += 1) {
    const path = `daily/2026-01-0${day}.md`;
    const raw = `---\ntitle: 华为发布消息\npublished: true\ndateCreated: 2026-01-0${day}T00:00:00Z\n---\n\n华为在北京市发布消息。\n`;
    const parsed = parseSourcePage(path, raw); pages.push(parsed.page); news.push(...parsed.news); rawPages.set(parsed.page.id, raw); sourceInventory[path] = sha256(raw);
  }
  const dataset = { ...template, generatedAt: AT, pages, news };
  const built = buildKnowledgeGraph({ dataset, rawPages, ontology, rules, generatedAt: AT, collectTrace: true });
  const provenance = buildCandidateProvenance({ ...built, dataset, rawPages, sourceInventory, bindings: {} });
  const input = { kg: built.kg, news: dataset, provenance };
  const huawei = built.kg.entities.find((row) => row.label === "华为"); assert.ok(huawei);
  const config = { ...emptyConfig(), identities: [identity("identity-huawei", "华为", "organization")], assignments: news.map((row) => assignment(input, row.id, huawei.id, "identity-huawei")) };
  const overlay = compileEntityIdentities({ ...input, config });
  for (const row of overlay.assignments) {
    assert.ok(provenance.assertions.some((assertion) => assertion.id === row.id));
    assert.deepEqual(new Set(row.supportIds.map((id) => provenance.supports.find((support) => support.id === id).method)), new Set(["direct_extraction", "global_name_rescan"]));
  }
  assert.deepEqual(validateEntityIdentityOverlay(overlay, { ...input, config }), []);

  // A real source withdrawal lowers the direct retention count from two to one.
  // The surviving news is unchanged, yet its assignment also becomes dormant.
  const remaining = { ...dataset, pages: [pages[1]], news: news.filter((row) => row.pageId === pages[1].id) };
  const smaller = buildKnowledgeGraph({ dataset: remaining, rawPages, ontology, rules, generatedAt: AT, collectTrace: true });
  const remainingInventory = { [pages[1].repositoryPath]: pages[1].contentHash };
  const smallerProvenance = buildCandidateProvenance({ ...smaller, dataset: remaining, rawPages, sourceInventory: remainingInventory, bindings: {} });
  assert.ok(!smaller.kg.entities.some((row) => row.id === huawei.id));
  const dormant = compileEntityIdentities({ kg: smaller.kg, news: remaining, provenance: smallerProvenance, config, baselineOverlay: overlay });
  assert.ok(dormant.assignments.every((row) => row.state === "dormant" && row.supportIds.length === 0));
  assert.deepEqual(compileEntityIdentities({ ...input, config, baselineOverlay: dormant }), overlay);
});


test("registry permutation has one reproducible normalized content digest", () => {
  const input = merged(); input.config.identities.push(identity("identity-2"));
  const original = compileEntityIdentities(input);
  input.config.identities.reverse(); input.config.assignments.reverse();
  assert.deepEqual(compileEntityIdentities(input), original);
  const reconstructed = { schemaVersion: 1, scope: ENTITY_IDENTITY_SCOPE, identities: original.identities, assignments: original.assignments.map(({ rawEntityType, state, supportIds, ...row }) => { void rawEntityType; void state; void supportIds; return row; }) };
  assert.equal(entityIdentitiesConfigHash(reconstructed), original.configHash);
});

test("projection metadata distinguishes two same-news assignments from one news unit", () => {
  const input = merged(); const overlay = compileEntityIdentities(input);
  const projection = projectIdentityEntities(input.kg, overlay);
  const entity = projection.entities.find((row) => row.id === "identity-1");
  assert.deepEqual(entity.identityResolution, { scope: ENTITY_IDENTITY_SCOPE, rawAssignmentCount: 3, newsCount: 2, rawEntityIds: ["raw-a", "raw-b"], independence: "not_assessed" });
  assert.equal(projection.events[0].identityAssignments.length, 2);
  assert.equal(projection.events[1].identityAssignments, undefined);
  assert.deepEqual(projection.events[0].identityAssignments.map((row) => row.assignmentId).sort(), overlay.assignments.filter((row) => row.newsId === "news-1").map((row) => row.id).sort());
});

test("app applies strict sparse chronology patches and rejects silent unknown fields", () => {
  const input = merged(); const overlay = compileEntityIdentities(input);
  assert.equal(applyIdentityResolution(input.kg), input.kg);
  const rawRelation = { id: "raw-relation", from: "event-1", to: "event-2", type: "precedes", viaEntityId: "raw-a", evidence: "Raw date order", sourceId: "source-2", confidence: 1 };
  input.kg.eventRelations = [rawRelation];
  const next = { id: "new-relation", from: "event-1", to: "event-3", type: "precedes", viaEntityId: "identity-1", evidence: "Reviewed date order", sourceId: "source-3", confidence: 1, identityDerivation: { kind: "reviewed_news_identity_date_order", fromAssignmentIds: overlay.assignments.filter((row) => row.newsId === "news-1").map((row) => row.id), toAssignmentIds: overlay.assignments.filter((row) => row.newsId === "news-3").map((row) => row.id) } };
  const wrapped = { ...input.kg, identityResolution: { schemaVersion: 1, overlay, chronology: { removedIds: [rawRelation.id], upserts: [next] } } };
  assert.deepEqual(applyIdentityResolution(wrapped).eventRelations, [next]);
  for (const mutate of [
    (value) => { value.identityResolution.extra = true; },
    (value) => { value.identityResolution.overlay.extra = true; },
    (value) => { value.identityResolution.overlay.assignments[0].extra = true; },
    (value) => { value.identityResolution.chronology.extra = true; },
    (value) => { value.identityResolution.chronology.removedIds = ["unknown"]; },
    (value) => { value.identityResolution.chronology.removedIds.push(rawRelation.id); },
    (value) => { value.identityResolution.chronology.upserts.push(next); },
    (value) => { value.identityResolution.chronology.upserts[0].id = rawRelation.id; },
    (value) => { value.identityResolution.chronology.upserts[0].extra = true; },
    (value) => { value.identityResolution.chronology.upserts[0].identityDerivation.extra = true; },
  ]) { const changed = clone(wrapped); mutate(changed); assert.throws(() => applyIdentityResolution(changed)); }
});

test("opaque identity namespace cannot collide with other record families", () => {
  for (const id of ["raw-a", "event-1", "source-1", "topic-science", "identity-", "identity-UPPER", "identity-has space"]) {
    const config = { ...emptyConfig(), identities: [identity(id)] };
    assert.throws(() => validateEntityIdentities(config), /invalid identity/u);
  }
});
