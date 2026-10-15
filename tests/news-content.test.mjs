import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { buildNewsContentSnapshot, buildNewsContentUpdates, validateNewsContentSnapshot, readContentSnapshot, NEWS_CONTENT_PATH } from "../scripts/lib/news-content.mjs";
import { acceptedArtifactNames, acceptedBundleNames, contentVersionFromFiles, selectContentVersion } from "../scripts/lib/accepted-content-protocol.mjs";

const sourceCommit = "a".repeat(40);
const bytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
function fixture(markdown = "完整新闻正文\n<!-- preserved source -->", id = "news-a") {
  const raw = Buffer.from(markdown.replaceAll("\n", "\r\n"));
  const inventory = { "daily/a.md": sha256(raw) };
  const news = { pages: [{ id: "page-a", repositoryPath: "daily/a.md", contentHash: sha256(raw) }], news: [{ id, pageId: "page-a", date: "1900-01-01", fragment: { sourceField: "body", startLine: 1, endLine: 2, contentHash: sha256(markdown) } }] };
  const kg = { entities: [{ id: "entity-a", type: "organization", label: "A" }], events: [] };
  const lifecycle = { effectiveInventory: inventory, states: { news: [{ id, state: "active" }], entities: [{ id: "entity-a", state: "active" }] }, transitions: { news: [] } };
  return { news, kg, lifecycle, sourceCommit, rawSources: new Map([["daily/a.md", raw]]) };
}

test("content snapshot preserves exact verified fragments, CRLF normalization, comments and unknown dates", () => {
  const value = fixture(); const snapshot = buildNewsContentSnapshot(value);
  assert.equal(snapshot.rows[0].markdown, "完整新闻正文\n<!-- preserved source -->");
  assert.deepEqual(snapshot.updates.addedNewsIds, []);
  assert.deepEqual(snapshot.updates.knownNewsIds, ["news-a"]);
  assert.deepEqual(snapshot.updates.addedEntityIds, []);
  assert.equal(validateNewsContentSnapshot(snapshot, value), snapshot);
  const metadata = fixture(); const text = 'description: "完整元数据正文"';
  const start = text.indexOf("完整"); const fragment = text.slice(start, text.indexOf('"', start));
  metadata.rawSources.set("daily/a.md", Buffer.from(text));
  metadata.news.pages[0].contentHash = sha256(text); metadata.lifecycle.effectiveInventory["daily/a.md"] = sha256(text);
  metadata.news.news[0].fragment = { sourceField: "frontmatter.description", startLine: 1, endLine: 1, startColumn: start + 1, endColumn: start + fragment.length, contentHash: sha256(fragment) };
  assert.equal(buildNewsContentSnapshot(metadata).rows[0].markdown, fragment);
});

test("content snapshots reject corrupt rows, wrong projections, omitted records and unverified source bytes", () => {
  const f = fixture(); const snapshot = buildNewsContentSnapshot(f);
  for (const edit of [
    (s) => { s.rows[0].markdown += "tampered"; },
    (s) => { s.rows = []; },
    (s) => { s.rows.push({ ...s.rows[0] }); },
    (s) => { s.newsSha256 = "b".repeat(64); },
    (s) => { s.kgSha256 = "b".repeat(64); },
    (s) => { s.effectiveInventorySha256 = "b".repeat(64); },
    (s) => { s.updates.addedNewsIds = ["not-active"]; },
  ]) {
    const changed = structuredClone(snapshot); edit(changed);
    assert.throws(() => validateNewsContentSnapshot(changed, { ...f, effectiveInventory: f.lifecycle.effectiveInventory }), /News content/u);
  }
  f.rawSources.set("daily/a.md", Buffer.from("unverified"));
  assert.throws(() => buildNewsContentSnapshot(f), /source binding differs/u);
});

test("update index distinguishes accepted additions, restorations and revisions and retains dormant IDs", () => {
  const f = fixture(); const old = fixture();
  old.news.news = [{ ...old.news.news[0], id: "news-old", date: "2099-01-01" }];
  old.kg.entities = [{ id: "entity-old" }];
  old.lifecycle.states.news = [{ id: "news-a", state: "dormant" }, { id: "news-old", state: "active" }];
  old.lifecycle.states.entities = [{ id: "entity-a", state: "dormant" }, { id: "entity-old", state: "active" }];
  f.news.news.push({ ...f.news.news[0], id: "news-new", date: "1800-01-01" }, old.news.news[0]);
  f.kg.entities.push({ id: "entity-new" });
  f.lifecycle.transitions.news = [{ id: "news-old", transition: "changed" }];
  const index = buildNewsContentUpdates({ ...f, baseline: old });
  assert.deepEqual(index.addedNewsIds, ["news-new"]);
  assert.deepEqual(index.restoredNewsIds, ["news-a"]);
  assert.deepEqual(index.changedNewsIds, ["news-old"]);
  assert.deepEqual(index.addedEntityIds, ["entity-new"]);
  assert.deepEqual(index.restoredEntityIds, ["entity-a"]);
  assert.ok(index.knownEntityIds.includes("entity-old"));
});

test("tracked reader never promotes a v3 preview, and v4 works without any source checkout", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "news-content-reader-"));
  try {
    const f = fixture(); const snapshot = buildNewsContentSnapshot(f); const encoded = bytes(snapshot);
    await mkdir(resolve(directory, "data/processed"), { recursive: true });
    await writeFile(resolve(directory, NEWS_CONTENT_PATH), encoded);
    const receipt = { versions: { candidate: "3.0.0" }, source: { commit: sourceCommit }, acceptedFiles: {} };
    assert.equal(await readContentSnapshot(directory, { ...f, receipt }), null);
    receipt.versions.candidate = "4.0.0";
    receipt.acceptedFiles[NEWS_CONTENT_PATH] = { bytes: encoded.length, sha256: sha256(encoded) };
    receipt.inventories = { effective: { sha256: snapshot.effectiveInventorySha256 } };
    assert.deepEqual(await readContentSnapshot(directory, { ...f, receipt }), snapshot);
    await writeFile(resolve(directory, NEWS_CONTENT_PATH), Buffer.concat([encoded, Buffer.from(" ")]));
    await assert.rejects(readContentSnapshot(directory, { ...f, receipt }), /tracked content bytes/u);
    await rm(resolve(directory, NEWS_CONTENT_PATH));
    await assert.rejects(readContentSnapshot(directory, { ...f, receipt }), /v4 accepted snapshot is missing/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("version inventories are exact and the compatibility writer needs an explicit first v4 switch", () => {
  assert.equal(selectContentVersion(), "3.0.0");
  assert.equal(selectContentVersion("v4"), "4.0.0");
  assert.equal(selectContentVersion(undefined, "4.0.0"), "4.0.0");
  assert.throws(() => selectContentVersion("v3", "4.0.0"), /drop recorded content/u);
  for (const version of ["3.0.0", "4.0.0"]) {
    assert.equal(contentVersionFromFiles(acceptedBundleNames(version)), version);
    assert.throws(() => contentVersionFromFiles([...acceptedBundleNames(version), "source.tar.gz"]), /unknown/u);
  }
  assert.equal(acceptedArtifactNames("4.0.0").length, 7);
});
