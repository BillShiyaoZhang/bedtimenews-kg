import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, diffRecords } from "./candidate-bundle.mjs";
import { compileEntityIdentities, assignedEntityAssertionId, validateEntityIdentities, buildReviewedIdentityInputHash, entityIdentitiesConfigHash } from "./entity-identities.mjs";
import { projectIdentityEntities } from "../../app/lib/identity-projection.mjs";
import { buildChronologyRelations } from "./kg-build.mjs";

const equal = (a, b) => canonicalJson(a) === canonicalJson(b);

/** Absence belongs only to pre-registry checkpoints. Parse/read failures fail closed. */
export async function readIdentityRegistry(root) {
  let bytes;
  try { bytes = await readFile(resolve(root, "data/entity-identities.json")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * Raw extraction records stay byte-for-byte intact. This optional derived view
 * is replayed from exact registry decisions and the unchanged support ledger.
 */
export function attachIdentityResolution({ kg, news, provenance, config, baselineOverlay = null }) {
  if (Object.hasOwn(kg, "identityResolution")) throw new Error("Identity materialization requires a raw extraction graph");
  if (config === null || config === undefined) {
    if (baselineOverlay) throw new Error("A reviewed identity registry cannot be removed; clear its assignments explicitly");
    return kg;
  }
  validateEntityIdentities(config);
  // Introducing a deliberately empty registry changes the semantic input axis,
  // but does not invent any reviewed identity or alter legacy graph bytes.
  if (!baselineOverlay && config.identities.length === 0 && config.assignments.length === 0) return kg;
  const overlay = compileEntityIdentities({ kg, news, provenance, config, baselineOverlay });
  return { ...kg, identityResolution: { schemaVersion: 1, overlay, chronology: identityChronology(kg, overlay, config) } };
}

function identityChronology(kg, overlay, config) {
  const projected = projectIdentityEntities(kg, overlay);
  const expectedRelations = buildChronologyRelations(projected.events, projected.entities);
  const rawRelations = new Map(kg.eventRelations.map((row) => [row.id, row]));
  const nextRelationIds = new Set(expectedRelations.map((row) => row.id));
  const decisions = new Map(config.assignments.map((row) => [`${row.newsId}\0${row.rawEntityId}`, row]));
  const rawEvents = new Map(kg.events.map((row) => [row.id, row]));
  const endpointAssignments = (eventId, identityId) => {
    const event = rawEvents.get(eventId);
    return event.entityIds.filter((rawEntityId) => (decisions.get(`${event.newsId}\0${rawEntityId}`)?.identityId ?? rawEntityId) === identityId)
      .map((rawEntityId) => assignedEntityAssertionId(event.id, rawEntityId)).sort();
  };
  const upserts = expectedRelations.filter((row) => !rawRelations.has(row.id) || !equal(rawRelations.get(row.id), row)).map((row) => ({
    ...row,
    evidence: `按经审查的新闻级身份分配重算“${projected.entities.find((entity) => entity.id === row.viaEntityId).label}”的新闻日期相邻关系；不表示真实事件发生先后或因果。`,
    identityDerivation: {
      kind: "reviewed_news_identity_date_order",
      fromAssignmentIds: endpointAssignments(row.from, row.viaEntityId),
      toAssignmentIds: endpointAssignments(row.to, row.viaEntityId),
    },
  }));
  const chronology = {
    removedIds: [...rawRelations.keys()].filter((id) => !nextRelationIds.has(id)).sort(),
    upserts,
  };
  return chronology;
}

/** Full expected reconstruction, never an instruction to ignore unknown KG fields. */
export function validateIdentityResolution({ kg, news, provenance, config, baselineOverlay = null }) {
  try {
    const { identityResolution, ...raw } = kg;
    void identityResolution;
    const expected = attachIdentityResolution({ kg: raw, news, provenance, config, baselineOverlay });
    if (!equal(expected, kg)) throw new Error("stored identity overlay/chronology differs from exact reviewed reconstruction");
    return [];
  } catch (error) { return [{ level: "error", path: "identityResolution", message: error.message }]; }
}

export function identityDiff(before, after) {
  if (!before.identityResolution && !after.identityResolution) return {};
  const empty = { identities: [], assignments: [] };
  return { identity: {
    schemaVersion: 1,
    scope: "news_scoped_extraction_assignment",
    registry: diffRecords(before.identityResolution?.overlay ?? empty, after.identityResolution?.overlay ?? empty, { collections: ["identities", "assignments"] }),
    chronologyPatchChanged: !equal(before.identityResolution?.chronology ?? null, after.identityResolution?.chronology ?? null),
    note: "Reviewed identity changes reinterpret explicit news assignments; raw extraction supports remain independently addressable.",
  } };
}

/**
 * Render-only consistency gate. It never establishes dormant history authority;
 * accepted Git/audit replay owns that check. With a current raw ledger supplied,
 * every live mapping's support set is checked as well.
 */
export function validateIdentityRendering({ kg, news, config, provenance = null }) {
  try {
    if (config !== null && config !== undefined) validateEntityIdentities(config);
    const current = kg.identityResolution;
    if (!current) {
      if (config?.identities.length || config?.assignments.length) throw new Error("reviewed registry requires its compiled overlay");
      return [];
    }
    if (current.schemaVersion !== 1 || Object.keys(current).sort().join(",") !== "chronology,overlay,schemaVersion") throw new Error("invalid identity resolution wrapper");
    if (!config || current.overlay.configHash !== entityIdentitiesConfigHash(config)) throw new Error("identity registry digest differs from rendered overlay");
    const sorted = (rows) => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (!equal(sorted(config.identities), current.overlay.identities)) throw new Error("rendered identity definitions differ");
    const decisions = current.overlay.assignments.map(({ rawEntityType, state, supportIds, ...decision }) => { void rawEntityType; void state; void supportIds; return decision; });
    if (!equal(sorted(config.assignments), decisions)) throw new Error("rendered identity assignments differ");
    const items = new Map((Array.isArray(news) ? news : news.news).map((row) => [row.id, row]));
    const events = new Map(kg.events.map((row) => [row.newsId, row]));
    for (const row of current.overlay.assignments) {
      const item = items.get(row.newsId); const event = events.get(row.newsId);
      if (item && (item.fragment.contentHash !== row.fragmentHash || buildReviewedIdentityInputHash(item) !== row.inputHash)) throw new Error(`reviewed news input changed: ${row.id}`);
      const active = Boolean(event?.entityIds.includes(row.rawEntityId));
      if (row.state !== (active ? "active" : "dormant") || !Array.isArray(row.supportIds)) throw new Error(`rendered assignment state differs: ${row.id}`);
      if (active && row.id !== assignedEntityAssertionId(event.id, row.rawEntityId)) throw new Error(`rendered assignment identity differs: ${row.id}`);
      if (!active && row.supportIds.length) throw new Error(`dormant assignment retains live supports: ${row.id}`);
      if (active && provenance) {
        const ids = provenance.supports.filter((support) => support.assertionId === row.id).map((support) => support.id).sort();
        if (!ids.length || !equal(ids, row.supportIds)) throw new Error(`rendered assignment supports differ: ${row.id}`);
      }
    }
    if (!equal(identityChronology(kg, current.overlay, config), current.chronology)) throw new Error("rendered identity chronology differs from complete projected recomputation");
    return [];
  } catch (error) { return [{ level: "error", path: "identityResolution", message: error.message }]; }
}
