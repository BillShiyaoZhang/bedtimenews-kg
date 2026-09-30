import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { entityKey } from "./extraction.mjs";
import { ENTITY_IDENTITY_SCOPE, assignedEntityAssertionId, validateEntityIdentities, buildReviewedIdentityInputHash } from "./entity-identities.mjs";

const SCOPE = "extraction_assignment";
const HASH = /^[a-f0-9]{64}$/u;
const KINDS = ["entities", "news", "assertions"];
const LEDGER_COLLECTIONS = ["sourceRevisions", "newsRevisions", "dateDerivations", "inputs", "evidence", "observations", "retention", "classifications", "chronologyGroups", "assertions", "supports", "assertionRevisions", "duplicateContentGroups"];
const GRAPH_COLLECTIONS = ["entities", "events", "eventRelations", "entityRelations", "sources"];
const ensure = (value, message) => { if (!value) throw new Error(`Candidate lifecycle: ${message}`); };
const hash = (value) => sha256(canonicalJson(value));
const sorted = (values) => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const unique = (values) => [...new Set(values)].sort();
const clone = (value) => JSON.parse(canonicalJson(value));
const ref = (bundleId, recordId) => ({ bundleId, recordId });

function recordsById(records, name) {
  ensure(Array.isArray(records), `${name} must be an array`);
  const result = new Map();
  for (const record of records) {
    ensure(record && typeof record.id === "string" && record.id.length && !result.has(record.id), `missing or duplicate ID in ${name}`);
    result.set(record.id, record);
  }
  return result;
}

/**
 * A transient, compact substitute for a verified KG/news/ledger snapshot. This
 * retains hashes and identity/dependency metadata, never witnesses or raw text.
 * It is not a persisted artifact or a substitute for replaying the input bundle.
 */
export function summarizeCandidateLifecycleInput({ kg, news, provenance }) {
  ensure(kg && news && provenance?.epistemicScope === SCOPE, "expected a KG, news dataset and extraction-assignment ledger");
  const newsRecords = Array.isArray(news) ? news : news.news;
  const pageRecords = Array.isArray(news) ? kg.sources : news.pages;
  const collections = new Map();
  for (const name of GRAPH_COLLECTIONS) collections.set(`kg.${name}`, recordsById(kg[name], `kg.${name}`));
  collections.set("news.news", recordsById(newsRecords, "news.news"));
  collections.set("news.pages", recordsById(pageRecords, "news.pages"));
  for (const name of LEDGER_COLLECTIONS) collections.set(`provenance.${name}`, recordsById(provenance[name] ?? [], `provenance.${name}`));
  const hashes = new Map([...collections].map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, hash(row)]))]));
  const get = (table, id) => {
    const value = collections.get(table)?.get(id);
    ensure(value, `missing ${table}/${id}`);
    return value;
  };
  const ledger = (table) => collections.get(`provenance.${table}`);
  const eventsByNews = new Map();
  for (const event of collections.get("kg.events").values()) {
    get("news.news", event.newsId);
    ensure(!eventsByNews.has(event.newsId), `multiple events for news ${event.newsId}`);
    eventsByNews.set(event.newsId, event);
  }
  ensure(eventsByNews.size === collections.get("news.news").size, "news/event projection is not bijective");
  const revisionByNews = new Map();
  for (const revision of ledger("newsRevisions").values()) {
    get("news.news", revision.newsId);
    get("provenance.sourceRevisions", revision.sourceRevisionId);
    ensure(!revisionByNews.has(revision.newsId), `multiple current revisions for news ${revision.newsId}`);
    revisionByNews.set(revision.newsId, revision);
  }
  const supportIds = new Map();
  for (const support of ledger("supports").values()) {
    get("provenance.assertions", support.assertionId);
    const ids = supportIds.get(support.assertionId) ?? [];
    ids.push(support.id);
    supportIds.set(support.assertionId, ids);
  }
  const revisionByAssertion = new Map();
  for (const revision of ledger("assertionRevisions").values()) {
    get("provenance.assertions", revision.assertionId);
    ensure(revision.state === "materialized" && !revisionByAssertion.has(revision.assertionId), `invalid current assertion revision ${revision.id}`);
    ensure(canonicalJson(unique(revision.supportIds)) === canonicalJson(unique(supportIds.get(revision.assertionId) ?? [])) && revision.supportIds.length > 0 && new Set(revision.supportIds).size === revision.supportIds.length, `support set differs for ${revision.assertionId}`);
    revisionByAssertion.set(revision.assertionId, revision);
  }
  const pageById = collections.get("news.pages");
  const pathsForNews = (ids) => unique(ids.map((id) => {
    const item = get("news.news", id);
    const page = pageById.get(item.pageId);
    ensure(page && typeof page.repositoryPath === "string", `missing source page for news ${id}`);
    return page.repositoryPath;
  }));

  // A support ID can stay the same while its observation or retention revision
  // changes. Fingerprint the actual dependency closure within THIS snapshot.
  // Historical lookup must use the referenced bundle, never today's ID table.
  const dependencyHashes = new Map();
  const visiting = new Set();
  function fingerprint(table, id) {
    const key = `${table}/${id}`;
    if (dependencyHashes.has(key)) return dependencyHashes.get(key);
    ensure(!visiting.has(key), `cyclic prerequisite ${key}`);
    visiting.add(key);
    const row = get(`provenance.${table}`, id);
    const dependencies = [];
    const add = (name, ids) => { for (const value of ids ?? []) dependencies.push([name, value, fingerprint(name, value)]); };
    for (const [field, name] of Object.entries({ sourceRevisionId: "sourceRevisions", newsRevisionId: "newsRevisions", inputId: "inputs", observationId: "observations", decisionId: "classifications", groupId: "chronologyGroups", evidenceId: "evidence" })) {
      if (row[field]) add(name, [row[field]]);
    }
    for (const [field, name] of Object.entries({ newsRevisionIds: "newsRevisions", evidenceIds: "evidence", observationIds: "observations", dateDerivationIds: "dateDerivations", supportIds: "supports" })) add(name, row[field]);
    for (const prerequisite of row.prerequisiteIds ?? []) {
      const inRetention = ledger("retention").has(prerequisite);
      const inAssertions = ledger("assertions").has(prerequisite);
      ensure(inRetention !== inAssertions, `missing or ambiguous prerequisite ${prerequisite}`);
      add(inRetention ? "retention" : "assertions", [prerequisite]);
    }
    if (table === "assertions") add("supports", unique(supportIds.get(id) ?? []));
    if (table === "classifications") for (const step of row.steps ?? []) {
      add("inputs", [step.inputId]);
      add("evidence", step.evidenceIds);
    }
    dependencies.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    const result = hash([hashes.get(`provenance.${table}`).get(id), dependencies]);
    visiting.delete(key);
    dependencyHashes.set(key, result);
    return result;
  }

  const pathsByEntity = new Map();
  const assertionIdentities = sorted(ledger("assertions").values()).map((assertion) => {
    ensure(assertion.epistemicScope === SCOPE, `non-extraction assertion ${assertion.id}`);
    const from = get("kg.events", assertion.subject);
    let newsIds = [from.newsId];
    if (assertion.predicate === "news_date_precedes") newsIds.push(get("kg.events", assertion.object).newsId);
    else ensure(["assigned_entity", "assigned_legacy_domain"].includes(assertion.predicate), `unknown extraction predicate ${assertion.predicate}`);
    newsIds = unique(newsIds);
    const sourcePaths = pathsForNews(newsIds);
    if (assertion.predicate === "assigned_entity") {
      get("kg.entities", assertion.object);
      const paths = pathsByEntity.get(assertion.object) ?? new Set();
      for (const path of sourcePaths) paths.add(path);
      pathsByEntity.set(assertion.object, paths);
    }
    const revision = revisionByAssertion.get(assertion.id);
    ensure(revision, `missing revision for assertion ${assertion.id}`);
    for (const id of revision.supportIds) {
      const support = get("provenance.supports", id);
      const revisionIds = [...(support.newsRevisionIds ?? []), ...(support.newsRevisionId ? [support.newsRevisionId] : [])];
      if (support.observationId) revisionIds.push(get("provenance.observations", support.observationId).newsRevisionId);
      if (support.decisionId) revisionIds.push(get("provenance.classifications", support.decisionId).newsRevisionId);
      const supportedNews = unique(revisionIds.map((newsRevisionId) => get("provenance.newsRevisions", newsRevisionId).newsId));
      ensure(canonicalJson(supportedNews) === canonicalJson(newsIds), `cross-news support ${id}`);
    }
    return { id: assertion.id, recordHash: hashes.get("provenance.assertions").get(assertion.id), revisionId: revision.id, newsIds, supportIds: unique(revision.supportIds), derivationHash: fingerprint("assertions", assertion.id), sourcePaths };
  });
  const identities = {
    entities: sorted(collections.get("kg.entities").values()).map((entity) => ({
      id: entity.id,
      recordHash: hashes.get("kg.entities").get(entity.id),
      identityBasis: entity.type === "topic" ? { kind: "pinned_topic_id", key: entity.id } : { kind: "legacy_type_name", key: entityKey(entity.type, entity.label) },
      sourcePaths: unique(pathsByEntity.get(entity.id) ?? []),
    })),
    news: sorted(collections.get("news.news").values()).map((item) => {
      const revision = revisionByNews.get(item.id);
      ensure(revision, `missing revision for news ${item.id}`);
      return { id: item.id, recordHash: hashes.get("news.news").get(item.id), revisionId: revision.id, eventId: eventsByNews.get(item.id).id, sourcePaths: pathsForNews([item.id]) };
    }),
    assertions: assertionIdentities,
  };
  return {
    schemaVersion: 1,
    epistemicScope: SCOPE,
    records: Object.fromEntries([...hashes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, rows]) => [name, [...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])),
    supportDerivationHashes: [...ledger("supports").keys()].sort().map((id) => [id, fingerprint("supports", id)]),
    identities,
    ...(Object.hasOwn(kg, "identityResolution") ? { identityResolution: summarizeIdentityResolution(kg.identityResolution, { get, collections, ledger, assertionIdentities, pathsForNews }) } : {}),
  };
}

/** Keep reviewed interpretation separate from the unchanged extraction ledger. */
function summarizeIdentityResolution(wrapper, { get, collections, ledger, assertionIdentities, pathsForNews }) {
  ensure(wrapper?.schemaVersion === 1 && wrapper.overlay?.schemaVersion === 1 && wrapper.overlay.scope === ENTITY_IDENTITY_SCOPE, "invalid identity resolution scope/version");
  const overlay = wrapper.overlay;
  ensure(overlay.supportScope === "current_raw_provenance", "identity support references must use current raw provenance");
  const registry = recordsById(overlay.identities, "identity registry");
  const rows = recordsById(overlay.assignments, "identity assignments");
  const decisions = sorted(rows.values()).map(({ rawEntityType, state, supportIds, ...decision }) => {
    ensure(typeof rawEntityType === "string" && ["active", "dormant"].includes(state) && Array.isArray(supportIds), `invalid compiled assignment ${decision.id}`);
    return decision;
  });
  const config = { schemaVersion: 1, scope: ENTITY_IDENTITY_SCOPE, identities: sorted(registry.values()), assignments: decisions };
  validateEntityIdentities(config);
  ensure(hash(config) === overlay.configHash, "identity registry snapshot/hash differs");
  const rawIdentities = new Map(assertionIdentities.map((row) => [row.id, row]));
  const assignments = sorted(rows.values()).map((row) => {
    const raw = ledger("assertions").get(row.id);
    const rawIdentity = rawIdentities.get(row.id);
    const item = collections.get("news.news").get(row.newsId);
    const entity = collections.get("kg.entities").get(row.rawEntityId);
    const target = row.identityId === null ? null : registry.get(row.identityId);
    ensure(["person", "organization", "place", "facility", "policy", "document"].includes(row.rawEntityType), `invalid raw identity type ${row.id}`);
    ensure(!entity || entity.type === row.rawEntityType, `raw assignment type differs ${row.id}`);
    ensure(!target || target.type === row.rawEntityType, `identity target type differs ${row.id}`);
    if (item) ensure(item.fragment?.contentHash === row.fragmentHash && buildReviewedIdentityInputHash(item) === row.inputHash, `reviewed assignment input differs ${row.id}`);
    if (raw) {
      const event = get("kg.events", raw.subject);
      ensure(row.state === "active" && raw.predicate === "assigned_entity" && raw.epistemicScope === SCOPE && raw.object === row.rawEntityId && event.newsId === row.newsId && event.entityIds.includes(row.rawEntityId) && assignedEntityAssertionId(event.id, row.rawEntityId) === row.id, `invalid current identity assignment ${row.id}`);
      ensure(!target || target.status === "active", `active assignment targets tombstoned identity ${row.id}`);
      ensure(canonicalJson(row.supportIds) === canonicalJson(rawIdentity.supportIds), `identity support set differs ${row.id}`);
    } else {
      ensure(row.state === "dormant" && row.supportIds.length === 0 && (!item || !entity || row.identityId === null), `unsupported identity assignment ${row.id}`);
    }
    return { id: row.id, recordHash: hash(row), newsId: row.newsId, rawEntityId: row.rawEntityId, rawEntityType: row.rawEntityType,
      identityId: row.identityId, state: row.identityId === null ? "cleared" : row.state, rawState: row.state,
      fragmentHash: row.fragmentHash, inputHash: row.inputHash,
      revisionId: rawIdentity?.revisionId ?? null, supportIds: rawIdentity?.supportIds ?? [], derivationHash: rawIdentity?.derivationHash ?? null,
      sourcePaths: item ? pathsForNews([row.newsId]) : [] };
  });
  const identities = sorted(registry.values()).map((row) => {
    ensure(!collections.get("kg.entities").has(row.id), `reviewed identity collides with raw entity ${row.id}`);
    const assigned = assignments.filter((assignment) => assignment.identityId === row.id);
    const active = assigned.filter((assignment) => assignment.state === "active");
    return { id: row.id, type: row.type, registrationStatus: row.status, state: row.status === "tombstoned" ? "tombstoned" : active.length ? "active" : "dormant",
      recordHash: hash(row), derivationHash: hash(assigned.map((assignment) => [assignment.id, assignment.recordHash, assignment.derivationHash])),
      assignmentIds: assigned.map((assignment) => assignment.id), activeAssignmentIds: active.map((assignment) => assignment.id),
      sourcePaths: unique(assigned.flatMap((assignment) => assignment.sourcePaths)) };
  });
  return { schemaVersion: 1, scope: ENTITY_IDENTITY_SCOPE, configHash: overlay.configHash, identities, assignments };
}

function summaryFor(input) {
  const summary = input.summary ?? summarizeCandidateLifecycleInput(input);
  ensure(summary.schemaVersion === 1 && summary.epistemicScope === SCOPE && summary.records && summary.identities && Array.isArray(summary.supportDerivationHashes), "invalid compact input summary");
  for (const kind of KINDS) recordsById(summary.identities[kind], `summary.identities.${kind}`);
  if (Object.hasOwn(summary, "identityResolution")) {
    const value = summary.identityResolution;
    ensure(value?.schemaVersion === 1 && value.scope === ENTITY_IDENTITY_SCOPE && HASH.test(value.configHash ?? ""), "invalid compact identity resolution summary");
    for (const kind of ["identities", "assignments"]) recordsById(value[kind], `summary.identityResolution.${kind}`);
  }
  return summary;
}

function activeState(kind, identity, bundleId) {
  const state = { id: identity.id, state: "active", recordRef: ref(bundleId, identity.id) };
  if (kind === "entities") state.identityBasis = clone(identity.identityBasis);
  if (kind === "news") {
    state.newsRevisionRef = ref(bundleId, identity.revisionId);
    state.eventRef = ref(bundleId, identity.eventId);
  }
  if (kind === "assertions") {
    state.assertionRevisionRef = ref(bundleId, identity.revisionId);
    state.newsIds = [...identity.newsIds];
  }
  return state;
}

function resolveHistoricalRefs(value, bundleId) {
  if (Array.isArray(value)) return value.map((child) => resolveHistoricalRefs(child, bundleId));
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, "bundleId") || Object.hasOwn(value, "recordId")) {
    ensure(Object.keys(value).sort().join(",") === "bundleId,recordId" && (value.bundleId === "self" || HASH.test(value.bundleId)) && typeof value.recordId === "string" && value.recordId.length, "invalid historical record reference");
    return ref(value.bundleId === "self" ? bundleId : value.bundleId, value.recordId);
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveHistoricalRefs(child, bundleId)]));
}

function compareRecords(before, after, parentBundleId) {
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  const collections = {};
  if (!before) return { summary, collections };
  for (const name of unique([...Object.keys(before.records), ...Object.keys(after.records)])) {
    const oldRows = new Map(before.records[name] ?? []);
    const newRows = new Map(after.records[name] ?? []);
    const result = { added: [], removed: [], changed: [], unchanged: 0 };
    for (const id of unique([...oldRows.keys(), ...newRows.keys()])) {
      const oldHash = oldRows.get(id) ?? null;
      const newHash = newRows.get(id) ?? null;
      if (oldHash === newHash) result.unchanged += 1;
      else result[oldHash === null ? "added" : newHash === null ? "removed" : "changed"].push({ id, oldHash, newHash, before: oldHash === null ? null : ref(parentBundleId, id), after: newHash === null ? null : ref("self", id) });
    }
    for (const kind of ["added", "removed", "changed"]) summary[kind] += result[kind].length;
    summary.unchanged += result.unchanged;
    collections[name] = result;
  }
  return { summary, collections };
}

function supportChanges(before, after, oldHashes, newHashes, parentBundleId) {
  const oldIds = new Set(before?.supportIds ?? []);
  const newIds = new Set(after?.supportIds ?? []);
  return {
    removed: [...oldIds].filter((id) => !newIds.has(id)).sort().map((id) => ref(parentBundleId, id)),
    added: [...newIds].filter((id) => !oldIds.has(id)).sort().map((id) => ref("self", id)),
    changed: [...oldIds].filter((id) => newIds.has(id) && oldHashes.get(id) !== newHashes.get(id)).sort().map((id) => ({ before: ref(parentBundleId, id), after: ref("self", id) })),
    survivingCount: [...oldIds].filter((id) => newIds.has(id) && oldHashes.get(id) === newHashes.get(id)).length,
    currentCount: newIds.size,
  };
}

function reviewedState(kind, row, bundleId, previous = null) {
  const historical = previous ? resolveHistoricalRefs(previous, bundleId) : null;
  const state = { id: row.id, state: row.state, recordRef: ref(bundleId, row.id),
    sourcePaths: row.sourcePaths.length ? [...row.sourcePaths] : [...(historical?.sourcePaths ?? [])] };
  if (kind === "identities") {
    Object.assign(state, { type: row.type, registrationStatus: row.registrationStatus,
      assignmentRefs: row.assignmentIds.map((id) => ref(bundleId, id)), activeAssignmentIds: [...row.activeAssignmentIds],
      lastActiveRef: row.state === "active" ? ref(bundleId, row.id) : historical?.lastActiveRef ?? null });
  } else {
    Object.assign(state, { newsId: row.newsId, rawEntityId: row.rawEntityId, rawEntityType: row.rawEntityType,
      identityId: row.identityId, rawState: row.rawState,
      rawAssertionRef: row.rawState === "active" ? ref(bundleId, row.id) : null,
      rawAssertionRevisionRef: row.revisionId ? ref(bundleId, row.revisionId) : null,
      supportRefs: row.supportIds.map((id) => ref(bundleId, id)) });
    state.lastActive = row.state === "active" ? { recordRef: state.recordRef, rawAssertionRef: state.rawAssertionRef,
      rawAssertionRevisionRef: state.rawAssertionRevisionRef, supportRefs: state.supportRefs } : historical?.lastActive ?? null;
  }
  return state;
}

/** Immediate reviewed-interpretation history, never a real-world fact ledger. */
function buildIdentityResolutionLifecycle({ baseline, oldSummary, newSummary, parentBundleId, decisionPaths, oldSupportHashes, newSupportHashes }) {
  const before = oldSummary?.identityResolution;
  const after = newSummary.identityResolution;
  if (!before && !after) return null;
  ensure(after, "reviewed identity overlay cannot be dropped; clear assignments explicitly");
  const states = {}; const transitions = {};
  for (const kind of ["identities", "assignments"]) {
    const oldRows = recordsById(before?.[kind] ?? [], `previous reviewed ${kind}`);
    const newRows = recordsById(after[kind], `current reviewed ${kind}`);
    const historical = recordsById(baseline?.lifecycle?.identityResolution?.states?.[kind] ?? [], `previous reviewed lifecycle ${kind}`);
    for (const row of oldRows.values()) {
      const next = newRows.get(row.id);
      ensure(next, `reviewed ${kind} identity cannot be removed ${row.id}`);
      if (kind === "identities") ensure(next.type === row.type, `reviewed identity type cannot be reused ${row.id}`);
      else ensure(next.newsId === row.newsId && next.rawEntityId === row.rawEntityId && next.rawEntityType === row.rawEntityType, `reviewed assignment anchor cannot be reused ${row.id}`);
    }
    const output = []; const changes = [];
    for (const row of sorted(newRows.values())) {
      const previous = oldRows.get(row.id);
      if (kind === "assignments" && row.rawState === "dormant") ensure(previous, `new dormant assignment has no verified predecessor ${row.id}`);
      const previousState = previous ? reviewedState(kind, previous, parentBundleId, historical.get(row.id)) : null;
      const state = reviewedState(kind, row, "self", previousState);
      output.push(state);
      if (!baseline) continue;
      let transition; let reason;
      if (!previous) { transition = "added"; reason = kind === "identities" ? "new_reviewed_registration" : "new_reviewed_assignment"; }
      else if (kind === "identities" && row.registrationStatus !== previous.registrationStatus) {
        transition = row.registrationStatus === "tombstoned" ? "tombstoned" : "restored";
        reason = "reviewed_registration_status_changed";
      } else if (kind === "assignments" && row.identityId !== previous.identityId) {
        transition = row.identityId === null ? "cleared" : "reassigned";
        reason = row.identityId === null ? "reviewed_return_to_raw_assignment" : "reviewed_identity_target_changed";
      } else if (previous.state === "active" && row.state !== "active") {
        transition = "deactivated"; reason = kind === "identities" ? "no_current_supported_identity_assignments" : "no_current_raw_support";
      } else if (previous.state !== "active" && row.state === "active") {
        transition = "restored"; reason = "same_reviewed_identity_supported_again";
      } else if (previous.recordHash !== row.recordHash || previous.derivationHash !== row.derivationHash || previous.state !== row.state) {
        transition = "changed"; reason = "reviewed_record_or_raw_derivation_revised";
      } else continue;
      const change = { id: row.id, transition, reason, before: previousState?.recordRef ?? null, after: state.recordRef,
        oldHash: previous?.recordHash ?? null, newHash: row.recordHash,
        fromState: previous?.state ?? null, toState: row.state,
        sourceDecisionPaths: unique([...(previousState?.sourcePaths ?? []), ...state.sourcePaths]).filter((path) => decisionPaths.has(path)) };
      if (kind === "assignments") Object.assign(change, { fromIdentityId: previous?.identityId ?? null, toIdentityId: row.identityId,
        beforeRawAssertionRevision: previousState?.rawAssertionRevisionRef ?? previousState?.lastActive?.rawAssertionRevisionRef ?? null,
        afterRawAssertionRevision: state.rawAssertionRevisionRef,
        supportChanges: supportChanges(previous, row, oldSupportHashes, newSupportHashes, parentBundleId) });
      changes.push(change);
    }
    states[kind] = output;
    transitions[kind] = changes;
  }
  return { schemaVersion: 1, scope: ENTITY_IDENTITY_SCOPE,
    semantics: "reviewed_news_scoped_identity_interpretation_raw_extraction_supports_remain_separate",
    recordSemantics: "registry_records_live_in_kg_identityResolution_overlay_raw_references_in_provenance_of_their_bundle",
    configHash: after.configHash, initialization: before ? null : { identities: states.identities.length, assignments: states.assignments.length }, states, transitions };
}

/**
 * Build one immediate-parent transition and compact persistent identity states.
 * Inputs (including baseline.lifecycle) must first be semantically replayed by
 * the runner. A historical ref scopes its entire dependency closure to that
 * bundle. An active assertion's revision ref resolves its supports there; no
 * prior ledgers or cumulative transition lists are copied into this artifact.
 * Identity transition hashes describe active immediate-parent/current records:
 * restoration has oldHash null, while before still identifies its historical
 * last-active record (and that ancestor's manifest binds the actual old hash).
 */
export function buildCandidateLifecycle({ baseline = null, current, sourcePlan }) {
  ensure(current && sourcePlan, "current and sourcePlan are required");
  const parentBundleId = baseline?.bundleId ?? null;
  ensure(!baseline || HASH.test(parentBundleId ?? ""), "baseline requires a bundle ID");
  const oldSummary = baseline ? summaryFor(baseline) : null;
  const newSummary = summaryFor(current);
  const { observedInventory, effectiveInventory, sourceStates, decisions } = sourcePlan;
  for (const [name, inventory] of Object.entries({ observedInventory, effectiveInventory })) {
    ensure(inventory && !Array.isArray(inventory) && typeof inventory === "object" && Object.values(inventory).every((value) => HASH.test(value)), `invalid ${name}`);
  }
  ensure(sourceStates && !Array.isArray(sourceStates) && typeof sourceStates === "object" && Array.isArray(decisions), "invalid source states or decisions");
  const decisionPaths = new Set(decisions.map((decision) => decision.path));
  const oldSupportHashes = new Map(oldSummary?.supportDerivationHashes ?? []);
  const newSupportHashes = new Map(newSummary.supportDerivationHashes);
  const states = {};
  const transitions = { entities: [], news: [], assertions: [], records: compareRecords(oldSummary, newSummary, parentBundleId) };
  for (const kind of KINDS) {
    const oldIdentities = recordsById(oldSummary?.identities[kind] ?? [], `previous ${kind}`);
    const newIdentities = recordsById(newSummary.identities[kind], `current ${kind}`);
    const previous = new Map();
    // Current active state is always rebuilt. Never accept a stored lifecycle's
    // unsupported active IDs or let a stored dormant flag suppress a live ID.
    for (const state of recordsById(baseline?.lifecycle?.states?.[kind] ?? [], `previous lifecycle ${kind}`).values()) {
      ensure(["active", "dormant"].includes(state.state), `invalid lifecycle state ${state.id}`);
      if (state.state === "dormant") previous.set(state.id, resolveHistoricalRefs(state, parentBundleId));
    }
    for (const identity of oldIdentities.values()) previous.set(identity.id, activeState(kind, identity, parentBundleId));
    const result = new Map();
    for (const id of unique([...previous.keys(), ...newIdentities.keys()])) {
      const oldState = previous.get(id);
      const oldIdentity = oldIdentities.get(id);
      const identity = newIdentities.get(id);
      const next = identity ? activeState(kind, identity, "self") : { ...oldState, state: "dormant" };
      result.set(id, next);
      if (!baseline || !identity && oldState?.state === "dormant") continue;
      let transition;
      if (!oldState) transition = "added";
      else if (!identity) transition = "deactivated";
      else if (oldState.state === "dormant") transition = "restored";
      else if (oldIdentity.recordHash !== identity.recordHash || oldIdentity.revisionId !== identity.revisionId || oldIdentity.derivationHash !== identity.derivationHash) transition = "changed";
      else continue;
      const row = {
        id, transition,
        before: oldState?.recordRef ?? null,
        after: identity ? next.recordRef : null,
        oldHash: oldIdentity?.recordHash ?? null,
        newHash: identity?.recordHash ?? null,
        reason: transition === "deactivated" ? kind === "assertions" ? "last_support_removed" : "no_longer_materialized" : transition === "restored" ? "same_legacy_id_rematerialized" : transition === "added" ? "newly_materialized" : "record_or_derivation_revised",
        sourceDecisionPaths: unique([...(oldIdentity?.sourcePaths ?? []), ...(identity?.sourcePaths ?? [])]).filter((path) => decisionPaths.has(path)),
      };
      if (kind === "assertions") {
        row.supportChanges = supportChanges(oldIdentity, identity, oldSupportHashes, newSupportHashes, parentBundleId);
        if (transition === "changed" && row.supportChanges.removed.length && row.supportChanges.survivingCount) row.reason = "other_supports_remain";
        row.beforeRevision = oldState?.assertionRevisionRef ?? null;
        row.afterRevision = identity ? next.assertionRevisionRef : null;
      }
      transitions[kind].push(row);
    }
    states[kind] = sorted(result.values());
  }
  const identityResolution = buildIdentityResolutionLifecycle({ baseline, oldSummary, newSummary, parentBundleId, decisionPaths, oldSupportHashes, newSupportHashes });
  const referencedBundleIds = new Set(parentBundleId ? [parentBundleId] : []);
  function collect(value) {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "bundleId") && value.bundleId !== "self") referencedBundleIds.add(value.bundleId);
    for (const child of Object.values(value)) collect(child);
  }
  collect(states);
  collect(transitions);
  collect(identityResolution);
  return {
    schemaVersion: 1,
    epistemicScope: SCOPE,
    identitySemantics: "legacy_type_name_or_pinned_topic_id_not_resolved_real_world_identity",
    referenceSemantics: "record_reference_bundle_scopes_all_transitive_prerequisites",
    parentBundleId,
    referencedBundleIds: [...referencedBundleIds].sort(),
    observedInventory: clone(observedInventory),
    effectiveInventory: clone(effectiveInventory),
    sourceStates: clone(sourceStates),
    decisions: clone(decisions).sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0),
    initialization: baseline ? null : Object.fromEntries(KINDS.map((kind) => [kind, states[kind].length])),
    states,
    transitions,
    ...(identityResolution ? { identityResolution } : {}),
  };
}

/** Stored state is compared with replay output, never used to establish itself. */
export function validateCandidateLifecycle(lifecycle, options) {
  try {
    const expected = buildCandidateLifecycle(options);
    ensure(canonicalJson(lifecycle) === canonicalJson(expected), "stored lifecycle differs from deterministic reconstruction");
    return [];
  } catch (error) { return [{ level: "error", path: "lifecycle", message: error.message }]; }
}
