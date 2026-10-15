import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { applyIdentityResolution } from "./identity-projection.mjs";
import { readContentSnapshot, validateNewsContentSnapshot } from "../../scripts/lib/news-content.mjs";

let dataPromise;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const json = async (path) => JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));
const summary = ({ id, newsId, title, date, datePrecision, summary }) => ({ id, newsId, title, date, datePrecision, summary });
const newest = (a, b) => b.date.localeCompare(a.date) || a.newsId.localeCompare(b.newsId);

export function getReadingData() {
  dataPromise ??= (async () => {
    const [rawKG, news, receipt, state] = await Promise.all([json("data/generated/kg.json"), json("data/processed/news.json"), json("data/accepted-release.json"), json("data/archive-state.json")]);
    let snapshot = await readContentSnapshot(process.cwd(), { receipt, news, kg: rawKG });
    // A review preview is an explicit local build input, never acceptance authority.
    const preview = !!process.env.KG_CONTENT_PREVIEW_PATH;
    if (preview) {
      if (process.env.GITHUB_ACTIONS === "true") throw new Error("Content previews cannot be published by Actions");
      snapshot = JSON.parse(await readFile(resolve(process.env.KG_CONTENT_PREVIEW_PATH), "utf8"));
      validateNewsContentSnapshot(snapshot, { news, kg: rawKG, sourceCommit: receipt.source.commit, effectiveInventory: state.acceptedFiles });
    }
    const kg = applyIdentityResolution(rawKG);
    const events = new Map(kg.events.map((event) => [event.newsId, event]));
    const entities = new Map(kg.entities.map((entity) => [entity.id, entity]));
    const sources = new Map(kg.sources.map((source) => [source.id, source]));
    const items = new Map(news.news.map((item) => [item.id, item]));
    const bodies = new Map((snapshot?.rows ?? []).map((row) => [row.newsId, row]));
    const byEntity = new Map();
    for (const event of kg.events) for (const id of event.entityIds) {
      if (!byEntity.has(id)) byEntity.set(id, []);
      byEntity.get(id).push(event);
    }
    for (const rows of byEntity.values()) rows.sort(newest);
    const releaseId = `${receipt.releaseId.slice(0, 16)}-${snapshot ? digest(JSON.stringify(snapshot)).slice(0, 16) : "legacy"}`;
    const empty = { addedNewsIds: [], addedEntityIds: [], restoredNewsIds: [], restoredEntityIds: [], changedNewsIds: [], knownNewsIds: [...events.keys()].sort(), knownEntityIds: [...entities.keys()].sort() };
    const catalog = { releaseId, recorded: !!snapshot, hashes: Object.fromEntries(news.news.map((item) => [item.id, item.fragment.contentHash])), activeNewsIds: [...events.keys()].sort(), updates: snapshot?.updates ?? empty };
    return { kg, events, entities, sources, items, bodies, byEntity, catalog, preview };
  })();
  return dataPromise;
}
export async function getNewsArticle(newsId) {
  const data = await getReadingData(); const event = data.events.get(newsId);
  if (!event) return null;
  const item = data.items.get(newsId); const body = data.bodies.get(newsId);
  const relatedIds = new Set(); const related = [];
  for (const id of event.entityIds) for (const row of data.byEntity.get(id) ?? []) {
    if (row.newsId !== newsId && !relatedIds.has(row.newsId)) { relatedIds.add(row.newsId); related.push(row); }
  }
  related.sort(newest);
  return { releaseId: data.catalog.releaseId, event, source: data.sources.get(event.sourceIds[0]), entities: event.entityIds.map((id) => data.entities.get(id)).filter(Boolean),
    markdown: body?.markdown ?? null, contentHash: item.fragment.contentHash,
    contentStatus: !body ? "unrecorded" : item.fragment.sourceField === "frontmatter.description" ? "summary" : "body",
    related: related.slice(0, 8).map(summary), preview: data.preview };
}
export async function getEntityArticle(entityId) {
  const data = await getReadingData(); const entity = data.entities.get(entityId);
  if (!entity) return null;
  const rows = data.byEntity.get(entityId) ?? [];
  return { entity, total: rows.length, related: rows.map(summary) };
}
export async function getReadingManifest() {
  const data = await getReadingData();
  return { releaseId: data.catalog.releaseId, catalogUrl: `/reading/${data.catalog.releaseId}/catalog.json`, updateIndex: data.catalog.recorded ? { ...data.catalog.updates, recorded: true } : undefined };
}
