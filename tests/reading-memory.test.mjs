import test from "node:test";
import assert from "node:assert/strict";
import { beginVisit, readMemory, markRead, clearReadMemory } from "../app/lib/reading-memory.mjs";
const hash = "a".repeat(64);
const memory = () => { const rows = new Map(); return { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) }; };
const catalog = (releaseId, activeNewsIds, knownNewsIds = activeNewsIds, recorded = true) => ({ releaseId, activeNewsIds, recorded, hashes: Object.fromEntries(activeNewsIds.map((id) => [id, hash])), updates: { knownNewsIds } });
test("first visit establishes a baseline without declaring all archives new", () => {
  const local = memory(), session = memory(); assert.deepEqual(beginVisit(catalog("one", ["news-one"]), local, session).newIds, []);
  assert.equal(beginVisit(catalog("one", ["news-one"]), local, session).hasPreviousVisit, false);
  assert.equal(beginVisit(catalog("one", ["news-one"]), local, memory()).hasPreviousVisit, true);
  assert.deepEqual(readMemory(local).knownNewsIds, ["news-one"]);
});
test("a visit keeps its baseline across query changes, reloads and storage writes", () => {
  const local = memory(), session = memory(); beginVisit(catalog("one", ["news-one"]), local, memory());
  const two = catalog("two", ["news-one", "news-two"]);
  assert.deepEqual(beginVisit(two, local, session).newIds, ["news-two"]);
  markRead(local, "news-two", hash);
  assert.deepEqual(beginVisit(two, local, session).newIds, ["news-two"]);
  assert.deepEqual(beginVisit(catalog("three", ["news-one", "news-two", "news-three"]), local, session).newIds, ["news-two", "news-three"]);
  assert.deepEqual(beginVisit(two, local, memory()).newIds, []);
});
test("known dormant IDs are restored rather than newly introduced", () => {
  const local = memory(); beginVisit(catalog("one", ["news-one"], ["news-one", "news-old"]), local, memory());
  assert.deepEqual(beginVisit(catalog("two", ["news-one", "news-old", "news-two"]), local, memory()).newIds, ["news-two"]);
});
test("read state retains the exact fragment hash and marking unread is reversible", () => {
  const local = memory(); markRead(local, "news-one", hash);
  assert.equal(readMemory(local).read["news-one"], hash); assert.notEqual(readMemory(local).read["news-one"], "b".repeat(64));
  markRead(local, "news-one", hash, false); assert.equal(readMemory(local).read["news-one"], undefined);
});
test("clearing read status preserves the visit knowledge baseline", () => {
  const local = memory(); beginVisit(catalog("one", ["news-one"]), local, memory()); markRead(local, "news-one", hash);
  clearReadMemory(local); assert.deepEqual(readMemory(local).read, {}); assert.deepEqual(readMemory(local).knownNewsIds, ["news-one"]);
});
test("corrupt or disabled browser storage does not prevent reading", () => {
  const broken = { getItem() { throw new Error("disabled"); }, setItem() { throw new Error("disabled"); } };
  assert.deepEqual(beginVisit(catalog("one", ["news-one"]), broken, broken).newIds, []);
  assert.equal(markRead(broken, "news-one", hash).read["news-one"], hash);
  assert.deepEqual(beginVisit(catalog("legacy", ["news-one"], undefined, false), memory(), memory()).newIds, []);
});
