import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { readNewsFragment } from "./news.mjs";
import { applyIdentityResolution } from "../../app/lib/identity-projection.mjs";
import { NEWS_CONTENT_PATH } from "./accepted-content-protocol.mjs";

export { NEWS_CONTENT_PATH } from "./accepted-content-protocol.mjs";
export const NEWS_CONTENT_SCHEMA_VERSION = 1;
export const NEWS_CONTENT_MAX_BYTES = 64 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const updateNames = ["addedNewsIds", "addedEntityIds", "restoredNewsIds", "restoredEntityIds", "changedNewsIds", "knownNewsIds", "knownEntityIds"];
const must = (value, message) => { if (!value) throw new Error(`News content: ${message}`); };
const exact = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const sorted = (values) => [...new Set(values)].sort();
const ids = (rows = []) => rows.map((row) => row.id);
const hash = (value) => sha256(`${canonicalJson(value)}\n`);
const projectedEntities = (kg) => ids(applyIdentityResolution(kg).entities);
const knownEntities = (lifecycle, kg, snapshot) => sorted([...ids(lifecycle?.states?.entities), ...ids(lifecycle?.identityResolution?.states?.identities), ...projectedEntities(kg), ...(snapshot?.updates.knownEntityIds ?? [])]);

/** Collection changes use accepted lifecycle history, never publication dates. */
export function buildNewsContentUpdates({ news, kg, lifecycle, baseline = null }) {
  const liveNews = ids(news.news); const liveEntities = projectedEntities(kg);
  const previousNews = new Set(baseline ? ids(baseline.news.news) : liveNews);
  const previousEntities = new Set(baseline ? projectedEntities(baseline.kg) : liveEntities);
  const oldNews = new Set(baseline ? [...ids(baseline.lifecycle.states.news), ...(baseline.content?.updates.knownNewsIds ?? [])] : liveNews);
  const oldEntities = new Set(baseline ? knownEntities(baseline.lifecycle, baseline.kg, baseline.content) : liveEntities);
  return {
    addedNewsIds: sorted(liveNews.filter((id) => !oldNews.has(id))),
    addedEntityIds: sorted(liveEntities.filter((id) => !oldEntities.has(id))),
    restoredNewsIds: sorted(liveNews.filter((id) => oldNews.has(id) && !previousNews.has(id))),
    restoredEntityIds: sorted(liveEntities.filter((id) => oldEntities.has(id) && !previousEntities.has(id))),
    changedNewsIds: sorted((baseline ? lifecycle.transitions.news : []).filter((row) => row.transition === "changed" && previousNews.has(row.id)).map((row) => row.id)),
    knownNewsIds: sorted([...oldNews, ...ids(lifecycle.states.news), ...liveNews]),
    knownEntityIds: sorted([...oldEntities, ...knownEntities(lifecycle, kg), ...liveEntities]),
  };
}

/** Review binds the exact body and update artifact without copying source text. */
export function newsContentDiff(previous, current) {
  return { schemaVersion: 1, beforeSha256: previous ? hash(previous) : null, afterSha256: hash(current),
    fragmentCount: current.rows.length, updates: current.updates };
}

/** Sources must already be authenticated against the exact recipe commit. */
export function buildNewsContentSnapshot({ news, kg, lifecycle, sourceCommit, rawSources, baseline = null }) {
  must(rawSources instanceof Map, "verified raw sources are required");
  const pages = new Map(news.pages.map((page) => [page.id, page]));
  const texts = new Map();
  const rows = [...news.news].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((item) => {
    const page = pages.get(item.pageId); const bytes = rawSources.get(page?.repositoryPath);
    must(page && bytes && sha256(bytes) === page.contentHash && lifecycle.effectiveInventory[page.repositoryPath] === page.contentHash, `source binding differs: ${item.id}`);
    if (!texts.has(page.id)) texts.set(page.id, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { newsId: item.id, contentHash: item.fragment.contentHash, markdown: readNewsFragment(texts.get(page.id), item.fragment) };
  });
  const snapshot = { schemaVersion: NEWS_CONTENT_SCHEMA_VERSION, kind: "accepted-news-content", sourceCommit,
    newsSha256: hash(news), kgSha256: hash(kg), effectiveInventorySha256: sha256(canonicalJson(lifecycle.effectiveInventory)), rows,
    updates: buildNewsContentUpdates({ news, kg, lifecycle, baseline }) };
  validateNewsContentSnapshot(snapshot, { news, kg, sourceCommit, effectiveInventory: lifecycle.effectiveInventory });
  return snapshot;
}

export function validateNewsContentSnapshot(snapshot, { news, kg, sourceCommit, effectiveInventory, expectedUpdates } = {}) {
  must(exact(snapshot, ["schemaVersion", "kind", "sourceCommit", "newsSha256", "kgSha256", "effectiveInventorySha256", "rows", "updates"])
    && snapshot.schemaVersion === NEWS_CONTENT_SCHEMA_VERSION && snapshot.kind === "accepted-news-content"
    && COMMIT.test(snapshot.sourceCommit) && [snapshot.newsSha256, snapshot.kgSha256, snapshot.effectiveInventorySha256].every((value) => HASH.test(value)), "invalid snapshot header");
  must(Buffer.byteLength(`${canonicalJson(snapshot)}\n`) <= NEWS_CONTENT_MAX_BYTES, "snapshot exceeds 64 MiB byte budget");
  must(sourceCommit === undefined || snapshot.sourceCommit === sourceCommit, "source commit differs");
  must(!news || snapshot.newsSha256 === hash(news), "news projection hash differs");
  must(!kg || snapshot.kgSha256 === hash(kg), "KG projection hash differs");
  must(!effectiveInventory || snapshot.effectiveInventorySha256 === sha256(canonicalJson(effectiveInventory)), "effective inventory hash differs");
  must(Array.isArray(snapshot.rows), "missing content rows");
  let previous = ""; const rows = new Map();
  for (const row of snapshot.rows) {
    must(exact(row, ["newsId", "contentHash", "markdown"]) && typeof row.newsId === "string" && row.newsId > previous && HASH.test(row.contentHash)
      && typeof row.markdown === "string" && sha256(row.markdown) === row.contentHash, "invalid, duplicate, unordered or corrupted content row");
    previous = row.newsId; rows.set(row.newsId, row);
  }
  if (news) {
    must(same([...rows.keys()], sorted(ids(news.news))), "content/news projection is not bijective");
    for (const item of news.news) must(rows.get(item.id)?.contentHash === item.fragment.contentHash, `fragment binding differs: ${item.id}`);
  }
  must(exact(snapshot.updates, updateNames), "invalid update index fields");
  for (const name of updateNames) {
    const values = snapshot.updates[name];
    must(Array.isArray(values) && values.every((id) => typeof id === "string" && id.trim()) && same(values, sorted(values)), `invalid update IDs: ${name}`);
  }
  const updates = snapshot.updates;
  const liveNews = new Set(rows.keys()); const knownNews = new Set(updates.knownNewsIds); const knownEntity = new Set(updates.knownEntityIds);
  const liveEntity = kg ? new Set(projectedEntities(kg)) : knownEntity;
  must([...liveNews].every((id) => knownNews.has(id)) && [...liveEntity].every((id) => knownEntity.has(id)), "known history omits current IDs");
  for (const name of ["addedNewsIds", "restoredNewsIds", "changedNewsIds"]) must(updates[name].every((id) => liveNews.has(id)), `${name} contains inactive news`);
  for (const name of ["addedEntityIds", "restoredEntityIds"]) must(updates[name].every((id) => liveEntity.has(id)), `${name} contains inactive entities`);
  must(!updates.addedNewsIds.some((id) => updates.restoredNewsIds.includes(id) || updates.changedNewsIds.includes(id))
    && !updates.restoredNewsIds.some((id) => updates.changedNewsIds.includes(id)) && !updates.addedEntityIds.some((id) => updates.restoredEntityIds.includes(id)), "update categories overlap");
  must(expectedUpdates === undefined || same(updates, expectedUpdates), "update index differs from lifecycle replay");
  return snapshot;
}

/** Server/build entry point. Only receipt-bound tracked JSON, no source fallback. */
export async function readContentSnapshot(root, { receipt, news, kg } = {}) {
  const required = receipt?.versions?.candidate === "4.0.0";
  // A local preview file beside a legacy receipt never upgrades that receipt.
  if (!required) return null;
  let bytes;
  try { bytes = await readFile(resolve(root, NEWS_CONTENT_PATH)); }
  catch (error) { if (error.code === "ENOENT") throw new Error("News content: v4 accepted snapshot is missing"); throw error; }
  must(receipt?.acceptedFiles?.[NEWS_CONTENT_PATH], "content JSON is not bound by the accepted receipt");
  const binding = receipt.acceptedFiles[NEWS_CONTENT_PATH];
  must(bytes.length <= NEWS_CONTENT_MAX_BYTES && bytes.length === binding.bytes && sha256(bytes) === binding.sha256, "tracked content bytes differ from receipt");
  const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  must(bytes.equals(Buffer.from(`${canonicalJson(snapshot)}\n`)), "tracked snapshot is not canonical JSON");
  must(snapshot.effectiveInventorySha256 === receipt.inventories.effective.sha256, "effective inventory differs from receipt");
  return validateNewsContentSnapshot(snapshot, { news, kg, sourceCommit: receipt.source.commit });
}
