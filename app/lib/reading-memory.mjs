const KEY = "history-atlas-reading-v1";
const VISIT_KEY = "history-atlas-visit-v1";
const safe = (storage, key) => { try { return JSON.parse(storage?.getItem(key) ?? "null"); } catch { return null; } };
const write = (storage, key, value) => { try { storage?.setItem(key, JSON.stringify(value)); } catch { /* Reading works without storage. */ } };
export function readMemory(storage) {
  const value = safe(storage, KEY);
  return value && value.version === 1 && value.read && typeof value.read === "object" && !Array.isArray(value.read)
    ? { ...value, read: Object.fromEntries(Object.entries(value.read).filter(([id, hash]) => /^news-[a-zA-Z0-9-]+$/.test(id) && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) }
    : { version: 1, read: {}, knownNewsIds: null, releaseId: null };
}
export function beginVisit(catalog, storage, session) {
  const memory = readMemory(storage); const current = safe(session, VISIT_KEY);
  const hasPreviousVisit = Array.isArray(current?.baseline) && typeof current.hasPreviousVisit === "boolean" ? current.hasPreviousVisit : Array.isArray(memory.knownNewsIds);
  let baseline = Array.isArray(current?.baseline) ? current.baseline : memory.knownNewsIds;
  if (!Array.isArray(baseline)) baseline = [...catalog.updates.knownNewsIds];
  const known = new Set(baseline);
  const newIds = catalog.recorded ? catalog.activeNewsIds.filter((id) => !known.has(id)) : [];
  write(session, VISIT_KEY, { releaseId: catalog.releaseId, baseline, hasPreviousVisit });
  write(storage, KEY, { ...memory, knownNewsIds: catalog.updates.knownNewsIds, releaseId: catalog.releaseId });
  return { memory, newIds, hasPreviousVisit };
}
export function markRead(storage, newsId, contentHash, read = true) {
  const memory = readMemory(storage); const next = { ...memory, read: { ...memory.read } };
  if (read) next.read[newsId] = contentHash; else delete next.read[newsId];
  write(storage, KEY, next); return next;
}
export function clearReadMemory(storage) { const memory = { ...readMemory(storage), read: {} }; write(storage, KEY, memory); return memory; }
