import assert from "node:assert/strict";
import test from "node:test";
import { buildNewsDataset } from "../scripts/lib/news-build.mjs";
const texts = {
  "daily/first.md": "---\ntitle: 华为工资与排班\npublished: true\ndateCreated: 2026-01-01T00:00:00Z\n---\n\n北京市华为介绍工资与排班情况。\n",
  "daily/second.md": "---\ntitle: 劳动保障\npublished: true\ndateCreated: 2026-01-02T00:00:00Z\n---\n\n工资与劳动保障。\n",
};
const options = { readSource: (path) => texts[path], overrides: { version: "fixture", pages: {} }, generatedAt: "2026-01-03T00:00:00Z" };
test("shared news builder has deterministic path order and explicit clock", async () => {
  const first = await buildNewsDataset({ ...options, sourceEntries: Object.keys(texts) });
  const second = await buildNewsDataset({ ...options, sourceEntries: Object.keys(texts).reverse() });
  assert.deepEqual(first, second); assert.equal(first.dataset.news.length, 2);
  await assert.rejects(buildNewsDataset({ ...options, generatedAt: undefined, sourceEntries: [] }), /pinned/u);
});
test("shared news builder rejects unsafe/duplicate paths and supports reviewed empty snapshots", async () => {
  for (const sourceEntries of [["../bad.md"], ["daily/first.md", "daily/first.md"], ["/bad.md"], ["daily\\bad.md"]]) await assert.rejects(buildNewsDataset({ ...options, sourceEntries }), /Invalid/u);
  const empty = await buildNewsDataset({ ...options, sourceEntries: [] });
  assert.deepEqual(empty.dataset.news, []); assert.deepEqual(empty.dataset.pages, []);
});
