import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { isSourceReviewTimestamp } from "./candidate-source-review.mjs";

export const ENTITY_IDENTITY_SCOPE = "news_scoped_extraction_assignment";
const TYPES = new Set(["person", "organization", "place", "facility", "policy", "document"]);
const HASH = /^[a-f0-9]{64}$/u;
const ensure = (value, message) => { if (!value) throw new Error(`Entity identities: ${message}`); };
const hash = (value) => sha256(canonicalJson(value));
const clone = (value) => JSON.parse(canonicalJson(value));
const text = (value) => typeof value === "string" && value.trim().length > 0;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sorted = (rows) => [...rows].sort((a, b) => compare(a.id, b.id));
const unique = (rows) => [...new Set(rows)].sort(compare);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const pair = (newsId, rawEntityId) => canonicalJson([newsId, rawEntityId]);

function byId(rows, name) {
  ensure(Array.isArray(rows), `${name} must be an array`);
  const result = new Map();
  for (const row of rows) {
    ensure(row && text(row.id) && !result.has(row.id), `missing or duplicate ID in ${name}`);
    result.set(row.id, row);
  }
  return result;
}

/** The review pins consumed news fields, not changing corpus/date metadata. */
export function buildReviewedIdentityInputHash(news) {
  ensure(news && text(news.id) && typeof news.title === "string" && typeof news.summary === "string" && HASH.test(news.fragment?.contentHash ?? ""), "review input requires news ID, title, summary and fragment SHA-256");
  return hash({ newsId: news.id, title: news.title, summary: news.summary, fragmentHash: news.fragment.contentHash });
}

/** Mirrors the existing ledger identity, including its extraction-only scope. */
export function assignedEntityAssertionId(eventId, rawEntityId) {
  ensure(text(eventId) && text(rawEntityId), "assignment requires event and raw entity IDs");
  return `assertion-${hash({ subject: eventId, predicate: "assigned_entity", object: rawEntityId, epistemicScope: "extraction_assignment" }).slice(0, 24)}`;
}

/** Canonical reviewed content digest; array order and file whitespace are not semantic. */
export function entityIdentitiesConfigHash(config) {
  validateEntityIdentities(config);
  return hash({ ...config, identities: sorted(config.identities), assignments: sorted(config.assignments) });
}

/**
 * Explicit current decisions only. Accepted predecessor bundles retain history.
 * A null identityId is a reviewed reversal to the original extraction identity.
 * Targets are registry IDs, never other assignments or transitive redirects.
 */
export function validateEntityIdentities(config) {
  canonicalJson(config);
  ensure(exactKeys(config, ["schemaVersion", "scope", "identities", "assignments"]) && config.schemaVersion === 1 && config.scope === ENTITY_IDENTITY_SCOPE, "config requires schemaVersion 1 and news-scoped assignment scope");
  const identities = byId(config.identities, "identities");
  const assignments = byId(config.assignments, "assignments");
  for (const identity of identities.values()) {
    ensure(exactKeys(identity, ["id", "type", "label", "status", "reason", "reviewedAt"]), `identity has missing or unknown fields: ${identity.id}`);
    ensure(/^identity-[a-z0-9][a-z0-9-]*$/u.test(identity.id) && TYPES.has(identity.type) && text(identity.label) && ["active", "tombstoned"].includes(identity.status) && text(identity.reason) && isSourceReviewTimestamp(identity.reviewedAt), `invalid identity type, status or review: ${identity.id}`);
  }
  const keys = new Set();
  for (const assignment of assignments.values()) {
    ensure(exactKeys(assignment, ["id", "newsId", "rawEntityId", "fragmentHash", "inputHash", "identityId", "reason", "reviewedAt"]), `assignment has missing or unknown fields: ${assignment.id}`);
    ensure(/^assertion-[a-f0-9]{24}$/u.test(assignment.id) && text(assignment.newsId) && text(assignment.rawEntityId) && HASH.test(assignment.fragmentHash) && HASH.test(assignment.inputHash) && text(assignment.reason) && isSourceReviewTimestamp(assignment.reviewedAt), `invalid assignment or review: ${assignment.id}`);
    ensure(assignment.identityId === null || text(assignment.identityId) && identities.has(assignment.identityId), `unknown identity target: ${assignment.id}`);
    const key = pair(assignment.newsId, assignment.rawEntityId);
    ensure(!keys.has(key), `duplicate news/raw entity assignment: ${assignment.newsId}/${assignment.rawEntityId}`);
    keys.add(key);
  }
  return config;
}

function indexes({ kg, news, provenance }) {
  ensure(kg && provenance?.epistemicScope === "extraction_assignment", "expected raw graph and extraction-assignment provenance");
  const entities = byId(kg.entities, "kg.entities");
  const events = byId(kg.events, "kg.events");
  const items = byId(Array.isArray(news) ? news : news?.news, "news");
  const assertions = byId(provenance.assertions, "provenance.assertions");
  const supports = byId(provenance.supports, "provenance.supports");
  const observations = byId(provenance.observations ?? [], "provenance.observations");
  const revisions = byId(provenance.newsRevisions, "provenance.newsRevisions");
  const assertionRevisions = byId(provenance.assertionRevisions, "provenance.assertionRevisions");
  const eventsByNews = new Map();
  for (const event of events.values()) {
    ensure(items.has(event.newsId) && !eventsByNews.has(event.newsId), `unknown or duplicate event news: ${event.id}`);
    ensure(Array.isArray(event.entityIds) && new Set(event.entityIds).size === event.entityIds.length && event.entityIds.every((id) => entities.has(id)), `invalid event entity assignments: ${event.id}`);
    eventsByNews.set(event.newsId, event);
  }
  ensure(eventsByNews.size === items.size, "news/event projection must be bijective");
  const supportsByAssertion = new Map();
  for (const support of supports.values()) {
    ensure(assertions.has(support.assertionId), `support references unknown assertion: ${support.id}`);
    const values = supportsByAssertion.get(support.assertionId) ?? [];
    values.push(support.id); supportsByAssertion.set(support.assertionId, values);
  }
  const revisionByAssertion = new Map();
  for (const revision of assertionRevisions.values()) {
    ensure(assertions.has(revision.assertionId) && !revisionByAssertion.has(revision.assertionId), `unknown or duplicate assertion revision: ${revision.id}`);
    revisionByAssertion.set(revision.assertionId, revision);
  }
  const assignments = new Map();
  for (const assertion of assertions.values()) {
    if (assertion.predicate !== "assigned_entity") continue;
    const event = events.get(assertion.subject);
    ensure(assertion.epistemicScope === "extraction_assignment" && event?.entityIds.includes(assertion.object) && assertion.id === assignedEntityAssertionId(event.id, assertion.object), `invalid raw entity assertion: ${assertion.id}`);
    const key = pair(event.newsId, assertion.object);
    ensure(!assignments.has(key), `duplicate raw assignment: ${key}`);
    const revision = revisionByAssertion.get(assertion.id);
    const supportIds = unique(supportsByAssertion.get(assertion.id) ?? []);
    ensure(revision?.state === "materialized" && Array.isArray(revision.supportIds) && revision.supportIds.length === supportIds.length && same(unique(revision.supportIds), supportIds) && supportIds.length > 0, `invalid raw assignment support set: ${assertion.id}`);
    for (const id of supportIds) {
      const support = supports.get(id);
      ensure(["direct_extraction", "global_name_rescan"].includes(support.method), `unsupported assignment support method: ${id}`);
      const newsRevisionIds = [...(support.newsRevisionIds ?? []), ...(support.newsRevisionId ? [support.newsRevisionId] : [])];
      if (support.observationId) {
        const observation = observations.get(support.observationId);
        ensure(observation?.entityId === assertion.object, `wrong raw entity observation: ${id}`);
        newsRevisionIds.push(observation.newsRevisionId);
      }
      ensure(newsRevisionIds.length > 0 && newsRevisionIds.every((revisionId) => revisions.get(revisionId)?.newsId === event.newsId), `cross-news assignment support: ${id}`);
    }
    assignments.set(key, { assertion, event, supportIds });
  }
  ensure(assignments.size === [...events.values()].reduce((sum, event) => sum + event.entityIds.length, 0), "raw assignment/graph projection must be bijective");
  return { entities, eventsByNews, items, assignments };
}

function reviewChanged(previous, current, fields) {
  ensure(Date.parse(current.reviewedAt) >= Date.parse(previous.reviewedAt), `review timestamp cannot go backwards: ${current.id}`);
  if (fields.some((field) => !same(previous[field], current[field]))) {
    ensure(current.reviewedAt !== previous.reviewedAt && Date.parse(current.reviewedAt) > Date.parse(previous.reviewedAt), `changed decision requires a later explicit review: ${current.id}`);
  }
}

/**
 * baselineOverlay is a previously verified accepted bundle's overlay. The caller
 * owns that authority boundary; arbitrary JSON cannot establish historical facts.
 * Normalized canonical configHash is NOT the SHA-256 of the original JSON file's bytes.
 * Supports always point into this candidate's untouched raw provenance. Neither
 * number of supports nor number of assignments is an independent-source count.
 */
export function compileEntityIdentities({ kg, news, provenance, config, baselineOverlay = null }) {
  validateEntityIdentities(config);
  const current = indexes({ kg, news, provenance });
  const identities = byId(config.identities, "identities");
  const decisions = byId(config.assignments, "assignments");
  if (baselineOverlay !== null) ensure(baselineOverlay.schemaVersion === 1 && baselineOverlay.scope === ENTITY_IDENTITY_SCOPE, "invalid verified baseline overlay");
  const previousIdentities = byId(baselineOverlay?.identities ?? [], "baseline identities");
  const previousAssignments = byId(baselineOverlay?.assignments ?? [], "baseline assignments");
  for (const previous of previousIdentities.values()) {
    const identity = identities.get(previous.id);
    ensure(identity && identity.type === previous.type, `historical identity ID/type cannot be removed or reused: ${previous.id}`);
    reviewChanged(previous, identity, ["label", "status", "reason"]);
  }
  for (const previous of previousAssignments.values()) {
    const decision = decisions.get(previous.id);
    ensure(decision && decision.newsId === previous.newsId && decision.rawEntityId === previous.rawEntityId, `historical assignment anchor cannot be removed or reused: ${previous.id}`);
    reviewChanged(previous, decision, ["fragmentHash", "inputHash", "identityId", "reason"]);
  }
  for (const identity of identities.values()) ensure(!current.entities.has(identity.id), `registry identity collides with raw entity ID: ${identity.id}`);
  const assignments = [];
  for (const decision of sorted(decisions.values())) {
    const previous = previousAssignments.get(decision.id);
    const item = current.items.get(decision.newsId);
    const raw = current.assignments.get(pair(decision.newsId, decision.rawEntityId));
    const entity = current.entities.get(decision.rawEntityId);
    if (item) ensure(item.fragment.contentHash === decision.fragmentHash && buildReviewedIdentityInputHash(item) === decision.inputHash, `reviewed news input changed: ${decision.id}`);
    if (raw) ensure(raw.assertion.id === decision.id, `reviewed raw assertion changed: ${decision.id}`);
    const rawEntityType = entity?.type ?? previous?.rawEntityType;
    ensure(TYPES.has(rawEntityType), `unknown raw entity or excluded topic assignment: ${decision.id}`);
    ensure(!previous || previous.rawEntityType === rawEntityType, `historical raw entity type changed: ${decision.id}`);
    const target = decision.identityId === null ? null : identities.get(decision.identityId);
    ensure(!target || target.type === rawEntityType, `identity target type differs: ${decision.id}`);
    if (!raw) {
      // A known extraction link can disappear because a source is withdrawn or
      // global retention drops. Input edits still fail closed above. New typos
      // and newly invented absent assignments cannot bootstrap dormant history.
      ensure(previous && (previous.fragmentHash === decision.fragmentHash && previous.inputHash === decision.inputHash || item && decision.identityId === null), `unknown or changed dormant assignment: ${decision.id}`);
      ensure(decision.identityId === null || !item || !entity, `reviewed raw assignment disappeared from a retained entity: ${decision.id}`);
    } else ensure(!target || target.status === "active", `active assignment targets tombstoned identity: ${decision.id}`);
    assignments.push({ ...clone(decision), rawEntityType, state: raw ? "active" : "dormant", supportIds: raw ? raw.supportIds : [] });
  }
  return {
    schemaVersion: 1,
    scope: ENTITY_IDENTITY_SCOPE,
    configHash: entityIdentitiesConfigHash(config),
    supportScope: "current_raw_provenance",
    independence: "not_assessed_support_and_assignment_counts_are_not_independent_source_counts",
    identities: sorted(identities.values()).map(clone),
    assignments,
  };
}

/** Replay the full compact output, rejecting additions and omissions alike. */
export function validateEntityIdentityOverlay(overlay, options) {
  try {
    const expected = compileEntityIdentities(options);
    ensure(same(overlay, expected), "stored overlay differs from reviewed deterministic projection");
    return [];
  } catch (cause) {
    return [{ level: "error", path: "identityResolution", message: cause.message }];
  }
}

export { projectIdentityEntities, materializeIdentityGraph, applyIdentityResolution } from "../../app/lib/identity-projection.mjs";
