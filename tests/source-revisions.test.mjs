import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { parseSourcePage, validateNewsFragments } from "../scripts/lib/news.mjs";
import { applyReviewedSourceRevisions, validateSourceRevisions } from "../scripts/lib/source-revisions.mjs";

const path = "reference/1.md";
const before = `---
title: 【参考信息1】政策与科学
description: 北京市发布公共服务政策。科研团队公布研究成果。
published: true
date: 2026-08-01T00:00:00Z
dateCreated: 2026-08-01T00:00:00Z
---

# Tabs {.tabset}
## B站
<iframe src="https://example.test/video"></iframe>

#\x20
`;
const after = before.replace("date: 2026-08-01", "date: 2026-09-01") + "\n**后续动态：** 页面补充维护说明。\n";
const hash = (text) => createHash("sha256").update(text).digest("hex");

async function withFixture(run) {
  const prefix = resolve(tmpdir(), "source-revisions-");
  const sourceRoot = await mkdtemp(prefix);
  try {
    await mkdir(resolve(sourceRoot, "reference"));
    await writeFile(resolve(sourceRoot, path), after);
    const old = parseSourcePage(path, before);
    const current = parseSourcePage(path, after);
    assert.ok(old.news.length > 0);
    assert.deepEqual(current.news, old.news);
    const revision = {
      id: "reference-1-reviewed",
      path,
      fromHash: hash(before),
      toHash: hash(after),
      upstreamCommit: "a".repeat(40),
      reviewedAt: "2026-09-09T00:00:00Z",
      kind: "preserve_news",
      reason: "Only the maintenance date and unsegmented body changed; all accepted news are identical.",
    };
    const options = {
      sourceRoot,
      manifest: { schemaVersion: 1, revisions: [revision] },
      changes: { added: [], modified: [{ path, acceptedHash: hash(before), currentHash: hash(after) }], deleted: [], possibleRenames: [], duplicateAdditions: [] },
      dataset: { pages: [old.page], news: old.news },
      candidateDataset: { pages: [current.page], news: current.news },
      kg: { sources: [old.page], events: [{ id: "old-event" }], entities: [], eventRelations: [] },
    };
    await run(options);
  } finally {
    if (!resolve(sourceRoot).startsWith(prefix)) throw new Error("Unexpected fixture cleanup path");
    await rm(sourceRoot, { recursive: true, force: true });
  }
}

test("reviewed full-page changes pass strict hashes without rewriting news or events", async () => {
  await withFixture(async (options) => {
    const result = await applyReviewedSourceRevisions(options);
    assert.equal(result.applied.length, 1);
    assert.deepEqual(result.changes.modified, []);
    assert.equal(result.updatedPageCount, 1);
    assert.equal(result.dataset.news, options.dataset.news);
    assert.equal(result.kg.events, options.kg.events);
    assert.deepEqual(result.kg.sources, result.dataset.pages);
    assert.equal(result.dataset.pages[0].contentHash, hash(after));
    assert.equal(options.dataset.pages[0].contentHash, hash(before));
    assert.deepEqual(await validateNewsFragments(result.dataset, options.sourceRoot), []);
  });
});

test("unreviewed and mismatched revisions retain the old hash and fail strict source validation", async () => {
  await withFixture(async (options) => {
    for (const revisions of [[], [{ ...options.manifest.revisions[0], fromHash: "b".repeat(64) }], [{ ...options.manifest.revisions[0], toHash: "c".repeat(64) }]]) {
      const result = await applyReviewedSourceRevisions({ ...options, manifest: { schemaVersion: 1, revisions } });
      assert.equal(result.applied.length, 0);
      assert.equal(result.changes.modified.length, 1);
      assert.equal(result.dataset.pages[0].contentHash, hash(before));
      assert.ok((await validateNewsFragments(result.dataset, options.sourceRoot)).some((issue) => issue.path === "pages.0.contentHash"));
    }
  });
});

test("an approval cannot accept later bytes even when the earlier manifest still matches", async () => {
  await withFixture(async (options) => {
    await writeFile(resolve(options.sourceRoot, path), after + "another edit");
    await assert.rejects(applyReviewedSourceRevisions(options), /bytes changed during update/u);
  });
});

test("reviewed revisions reject changes to news content, dates, boundaries, additions and removals", async () => {
  await withFixture(async (options) => {
    for (const transform of [
      (news) => { news[0].title = "Another headline"; },
      (news) => { news[0].summary = "Another meaning"; },
      (news) => { news[0].date = "2026-09-09"; },
      (news) => { news[0].fragment.startColumn += 1; },
      (news) => { news.pop(); },
      (news) => { news.push({ ...news[0], id: "new-news" }); },
    ]) {
      const candidateDataset = structuredClone(options.candidateDataset);
      transform(candidateDataset.news);
      await assert.rejects(applyReviewedSourceRevisions({ ...options, candidateDataset }), /accepted news or boundaries/u);
    }
  });
});

test("reviewed revisions reject changed page metadata or inconsistent KG source projections", async () => {
  await withFixture(async (options) => {
    const candidateDataset = structuredClone(options.candidateDataset);
    candidateDataset.pages[0].publishedAt = "2026-09-09";
    await assert.rejects(applyReviewedSourceRevisions({ ...options, candidateDataset }), /page metadata/u);
    const kg = structuredClone(options.kg);
    kg.sources[0].title = "Corrupt source projection";
    await assert.rejects(applyReviewedSourceRevisions({ ...options, kg }), /page metadata/u);
  });
});

test("navigation approvals apply only when neither dataset references the page", async () => {
  await withFixture(async (options) => {
    const manifest = structuredClone(options.manifest);
    manifest.revisions[0].kind = "navigation_only";
    await assert.rejects(applyReviewedSourceRevisions({ ...options, manifest }), /Navigation review/u);
    const result = await applyReviewedSourceRevisions({ ...options, manifest, dataset: { pages: [], news: [] }, candidateDataset: { pages: [], news: [] }, kg: { sources: [] } });
    assert.equal(result.applied.length, 1);
    assert.equal(result.updatedPageCount, 0);
    assert.deepEqual(result.changes.modified, []);
  });
});

test("source revision manifests reject unsafe paths, invalid hashes and duplicate approvals", async () => {
  await withFixture(async ({ manifest }) => {
    for (const path of ["../escape.md", "reference/../escape.md", "C:/escape.md", "reference\\escape.md"]) {
      const invalid = structuredClone(manifest);
      invalid.revisions[0].path = path;
      assert.throws(() => validateSourceRevisions(invalid), /relative content Markdown path/u);
    }
    const invalid = structuredClone(manifest);
    invalid.revisions[0].toHash = "anything";
    assert.throws(() => validateSourceRevisions(invalid), /Invalid or duplicate/u);
    assert.throws(() => validateSourceRevisions({ ...manifest, revisions: [...manifest.revisions, { ...manifest.revisions[0], id: "duplicate-transition" }] }), /Duplicate source revision transition/u);
  });
});

test("checked-in source revision approvals have a valid auditable schema", async () => {
  const manifest = JSON.parse(await readFile(new URL("../data/source-revisions.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateSourceRevisions(manifest));
});
