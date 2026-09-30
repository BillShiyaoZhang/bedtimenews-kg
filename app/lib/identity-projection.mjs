// Browser-safe view kernel. The server first replays the overlay against the
// exact reviewed config and raw provenance; this module never guesses identities.
const SCOPE = "news_scoped_extraction_assignment";
const ensure = (value, message) => { if (!value) throw new Error(`Entity identities: ${message}`); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const pair = (newsId, rawEntityId) => JSON.stringify([newsId, rawEntityId]);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const compare = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function byId(rows, name) {
  ensure(Array.isArray(rows), `${name} must be an array`);
  const result = new Map();
  for (const row of rows) {
    ensure(row && typeof row.id === "string" && row.id.trim() && !result.has(row.id), `missing or duplicate ID in ${name}`);
    result.set(row.id, row);
  }
  return result;
}

function validateOverlay(overlay) {
  ensure(exactKeys(overlay, ["schemaVersion", "scope", "configHash", "supportScope", "independence", "identities", "assignments"]) && overlay.schemaVersion === 1 && overlay.scope === SCOPE && /^[a-f0-9]{64}$/u.test(overlay.configHash) && overlay.supportScope === "current_raw_provenance" && overlay.independence === "not_assessed_support_and_assignment_counts_are_not_independent_source_counts", "invalid overlay projection scope or fields");
  const types = new Set(["person", "organization", "place", "facility", "policy", "document"]);
  const identities = byId(overlay.identities, "overlay identities");
  const assignments = byId(overlay.assignments, "overlay assignments");
  const keys = new Set();
  for (const identity of identities.values()) {
    ensure(exactKeys(identity, ["id", "type", "label", "status", "reason", "reviewedAt"]) && /^identity-[a-z0-9][a-z0-9-]*$/u.test(identity.id) && types.has(identity.type) && typeof identity.label === "string" && identity.label.trim() && ["active", "tombstoned"].includes(identity.status) && typeof identity.reason === "string" && identity.reason.trim() && typeof identity.reviewedAt === "string" && Number.isFinite(Date.parse(identity.reviewedAt)), `invalid overlay identity: ${identity.id}`);
  }
  for (const row of assignments.values()) {
    const key = pair(row.newsId, row.rawEntityId);
    ensure(exactKeys(row, ["id", "newsId", "rawEntityId", "fragmentHash", "inputHash", "identityId", "reason", "reviewedAt", "rawEntityType", "state", "supportIds"]) && /^assertion-[a-f0-9]{24}$/u.test(row.id) && typeof row.newsId === "string" && row.newsId.trim() && typeof row.rawEntityId === "string" && row.rawEntityId.trim() && /^[a-f0-9]{64}$/u.test(row.fragmentHash) && /^[a-f0-9]{64}$/u.test(row.inputHash) && types.has(row.rawEntityType) && ["active", "dormant"].includes(row.state) && typeof row.reason === "string" && row.reason.trim() && typeof row.reviewedAt === "string" && Number.isFinite(Date.parse(row.reviewedAt)), `invalid overlay assignment: ${row.id}`);
    ensure(!keys.has(key), `duplicate news/raw projection assignment: ${key}`); keys.add(key);
    ensure(row.identityId === null || identities.has(row.identityId) && identities.get(row.identityId).type === row.rawEntityType, `invalid overlay identity target: ${row.id}`);
    ensure(Array.isArray(row.supportIds) && row.supportIds.every((id) => typeof id === "string" && id.trim()) && new Set(row.supportIds).size === row.supportIds.length && (row.state === "dormant" ? row.supportIds.length === 0 : row.supportIds.length > 0), `invalid overlay support references: ${row.id}`);
  }
  return { identities, assignments };
}

/**
 * IDs and evidence in the raw graph remain untouched. Reviews apply to one
 * news/raw-entity assignment, never every future occurrence of a matching name.
 * Raw entity order is retained; newly projected registry entities append in ID
 * order. Empty or cleared mappings preserve raw entities/events byte-for-byte.
 */
export function projectIdentityEntities(kg, overlay) {
  const { identities, assignments } = validateOverlay(overlay);
  const rawEntities = byId(kg.entities, "raw entities");
  const eventsByNews = new Map(kg.events.map((event) => [event.newsId, event]));
  const mapping = new Map();
  const reviewsByNews = new Map();
  const reviewsByIdentity = new Map();
  for (const assignment of assignments.values()) {
    const live = eventsByNews.get(assignment.newsId)?.entityIds.includes(assignment.rawEntityId) ?? false;
    ensure(live === (assignment.state === "active"), `overlay assignment state differs from raw graph: ${assignment.id}`);
    if (live) ensure(rawEntities.get(assignment.rawEntityId)?.type === assignment.rawEntityType, `overlay raw type differs: ${assignment.id}`);
    if (assignment.state !== "active" || assignment.identityId === null) continue;
    const key = pair(assignment.newsId, assignment.rawEntityId);
    ensure(!mapping.has(key), `duplicate projection assignment: ${key}`);
    const identity = identities.get(assignment.identityId);
    ensure(identity?.status === "active" && identity.type === assignment.rawEntityType && rawEntities.get(assignment.rawEntityId)?.type === identity.type && identity.type !== "topic" && !rawEntities.has(identity.id), `invalid projection target: ${assignment.id}`);
    ensure(eventsByNews.get(assignment.newsId)?.entityIds.includes(assignment.rawEntityId), `missing active raw assignment: ${assignment.id}`);
    mapping.set(key, assignment.identityId);
    const reviews = reviewsByNews.get(assignment.newsId) ?? [];
    reviews.push({ assignmentId: assignment.id, rawEntityId: assignment.rawEntityId, rawLabel: rawEntities.get(assignment.rawEntityId).label, identityId: assignment.identityId });
    reviewsByNews.set(assignment.newsId, reviews);
    const identityReviews = reviewsByIdentity.get(assignment.identityId) ?? [];
    identityReviews.push(assignment);
    reviewsByIdentity.set(assignment.identityId, identityReviews);
  }
  if (!mapping.size) return { entities: clone(kg.entities), events: clone(kg.events) };
  const events = kg.events.map((event) => ({
    ...clone(event),
    entityIds: [...new Set(event.entityIds.map((id) => mapping.get(pair(event.newsId, id)) ?? id))],
    ...(reviewsByNews.has(event.newsId) ? { identityAssignments: reviewsByNews.get(event.newsId).sort((a, b) => a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0) } : {}),
  }));
  const counts = new Map();
  for (const event of events) for (const id of event.entityIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const reviewedRawIds = new Set([...assignments.values()].filter((row) => row.state === "active" && row.identityId !== null).map((row) => row.rawEntityId));
  const entities = kg.entities.filter((entity) => counts.has(entity.id)).map((entity) => ({ ...clone(entity),
    ...(reviewedRawIds.has(entity.id) ? { description: `原始抽取名称；当前身份视图仍有 ${counts.get(entity.id)} 条新闻保留此归属，其他经审查的分配可分别追溯。` } : {}),
    ...(entity.extraction ? { extraction: { ...clone(entity.extraction), eventCount: counts.get(entity.id) } } : {}) }));
  for (const identity of [...identities.values()].sort(compare)) {
    if (!counts.has(identity.id)) continue;
    const reviews = reviewsByIdentity.get(identity.id);
    entities.push({ id: identity.id, type: identity.type, label: identity.label, aliases: [], description: "经人工审查的新闻级实体身份；原始抽取和来源支持保持分别追溯。", identityResolution: { scope: SCOPE, rawAssignmentCount: reviews.length, newsCount: new Set(reviews.map((row) => row.newsId)).size, rawEntityIds: [...new Set(reviews.map((row) => row.rawEntityId))].sort(), independence: "not_assessed" } });
  }
  return { entities, events };
}

function validateRelations(relations, projection) {
  const rows = byId(relations, "resolved event relations");
  const events = byId(projection.events, "projected events");
  const entities = byId(projection.entities, "projected entities");
  const pairs = new Set();
  for (const row of rows.values()) {
    const fields = ["id", "from", "to", "type", "viaEntityId", "evidence", "sourceId", ...(Object.hasOwn(row, "confidence") ? ["confidence"] : []), ...(Object.hasOwn(row, "identityDerivation") ? ["identityDerivation"] : [])];
    ensure(exactKeys(row, fields), `unknown or missing resolved chronology fields: ${row.id}`);
    if (row.identityDerivation) {
      const trace = row.identityDerivation;
      ensure(exactKeys(trace, ["kind", "fromAssignmentIds", "toAssignmentIds"]) && trace.kind === "reviewed_news_identity_date_order" && [trace.fromAssignmentIds, trace.toAssignmentIds].every((ids) => Array.isArray(ids) && ids.length > 0 && ids.every((id) => /^assertion-[a-f0-9]{24}$/u.test(id)) && new Set(ids).size === ids.length), `invalid resolved chronology derivation: ${row.id}`);
    }
    const from = events.get(row.from); const to = events.get(row.to);
    const key = JSON.stringify([row.from, row.to]);
    ensure(row.type === "precedes" && from && to && from.date !== "1900-01-01" && to.date !== "1900-01-01" && from.date < to.date && !pairs.has(key), `invalid resolved chronology endpoints: ${row.id}`);
    ensure(entities.has(row.viaEntityId) && entities.get(row.viaEntityId).type !== "topic" && from.entityIds.includes(row.viaEntityId) && to.entityIds.includes(row.viaEntityId), `invalid resolved chronology identity: ${row.id}`);
    ensure(typeof row.evidence === "string" && row.evidence.trim() && to.sourceIds.includes(row.sourceId) && (row.confidence === undefined || Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1), `invalid resolved chronology evidence: ${row.id}`);
    pairs.add(key);
  }
}

/**
 * Chronology must be rebuilt after mapping, including adjacency and mention caps.
 * Supplying relabeled old viaEntityIds is not a recomputation. The caller owns
 * derivation replay; here supplied relation shape/endpoints are checked as well.
 */
export function materializeIdentityGraph(kg, overlay, { eventRelations } = {}) {
  const mapped = overlay.assignments.some((row) => row.state === "active" && row.identityId !== null);
  ensure(!mapped || Array.isArray(eventRelations), "resolved chronology must be recomputed before materializing the graph");
  ensure(!mapped || (kg.entityRelations ?? []).length === 0, "resolved entity relations require a reviewed projection implementation");
  const projection = projectIdentityEntities(kg, overlay);
  if (eventRelations !== undefined) validateRelations(eventRelations, projection);
  const result = { ...clone(kg), ...projection, eventRelations: clone(eventRelations ?? kg.eventRelations) };
  delete result.identityResolution;
  if (overlay.identities.length || overlay.assignments.length) {
    const rawIds = [...new Set(overlay.assignments.map((row) => row.rawEntityId))].sort();
    result.identityNavigation = rawIds.map((rawEntityId) => {
      const entity = kg.entities.find((row) => row.id === rawEntityId);
      const rows = overlay.assignments.filter((row) => row.rawEntityId === rawEntityId);
      const interpreted = rows.filter((row) => row.identityId !== null);
      const targetIds = [...new Set(interpreted.map((row) => row.identityId))].sort();
      return { rawEntityId, label: entity?.label ?? rawEntityId, type: entity?.type ?? rows[0].rawEntityType,
        state: interpreted.some((row) => row.state === "active") ? "active" : interpreted.length ? "dormant" : "cleared",
        targets: targetIds.map((id) => ({ id, label: overlay.identities.find((row) => row.id === id).label, newsCount: new Set(interpreted.filter((row) => row.identityId === id && row.state === "active").map((row) => row.newsId)).size })) };
    });
    result.identityRegistrations = overlay.identities.map((identity) => ({ id: identity.id, label: identity.label, type: identity.type,
      state: identity.status === "tombstoned" ? "tombstoned" : overlay.assignments.some((row) => row.identityId === identity.id && row.state === "active") ? "active" : "dormant" }));
  }
  return result;
}

/** Apply the compact server-replayed wrapper without silently accepting drift. */
export function applyIdentityResolution(kg) {
  if (!Object.hasOwn(kg, "identityResolution")) return kg;
  const wrapper = kg.identityResolution;
  ensure(exactKeys(wrapper, ["schemaVersion", "overlay", "chronology"]) && wrapper.schemaVersion === 1, "invalid identity resolution wrapper");
  const patch = wrapper.chronology;
  ensure(exactKeys(patch, ["removedIds", "upserts"]) && Array.isArray(patch.removedIds) && Array.isArray(patch.upserts), "invalid chronology patch");
  const relations = byId(kg.eventRelations, "raw event relations");
  const removed = new Set();
  for (const id of patch.removedIds) {
    ensure(typeof id === "string" && relations.has(id) && !removed.has(id), `unknown or duplicate removed chronology ID: ${id}`);
    removed.add(id);
  }
  const upserts = byId(patch.upserts, "chronology upserts");
  for (const id of upserts.keys()) ensure(!removed.has(id), `chronology ID cannot be both removed and upserted: ${id}`);
  for (const id of removed) relations.delete(id);
  for (const [id, row] of upserts) relations.set(id, row);
  return materializeIdentityGraph(kg, wrapper.overlay, { eventRelations: [...relations.values()] });
}
