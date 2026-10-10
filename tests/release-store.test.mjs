import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, publishCandidateBundle, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { loadAcceptedGitCheckpoint } from "../scripts/lib/accepted-git.mjs";
import { acceptedReleaseIdentity, validateAcceptedReleaseStructure } from "../scripts/lib/accepted-release.mjs";
import { AUDIT_STORE_LIMITS, createGitHubReleaseStore, prepareAuditBundle } from "../scripts/lib/release-store.mjs";
import { createUploadRecoveryReservation } from "../scripts/lib/upload-recovery-journal.mjs";
import { runActionsAuditUpload, createObservedUploadTransport } from "../scripts/lib/actions-audit-upload.mjs";

const targetCommit = "a".repeat(40);
const token = "fake-test-token-never-a-real-credential";
const repository = "fixture/audit";
const base = `/repos/${repository}`;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function fixture(t, artifacts = { "kg.json": { entities: [] }, "lifecycle.json.gz": { transitions: [] } }) {
  const root = await mkdtemp(join(tmpdir(), "kg-release-store-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "bundle");
  const { manifest } = await publishCandidateBundle(dir, { artifacts,
    inputs: { generator: { sha256: sha256("fixture") } }, versions: { generator: "fixture-v1" } });
  return { root, dir, manifest, tag: `kg-audit-${manifest.bundleId}` };
}

function fakeGitHub({ onRequest, immutable = false } = {}) {
  const state = { releases: [], assets: new Map(), bytes: new Map(), tagObject: null, calls: [], nextId: 10, onRequest, immutable, commitShas: new Set([targetCommit]), mainCommit: null, remoteAncestry: new Set(), proposalCommit: null };
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    const call = { url, method: options.method, headers: options.headers, body: options.body, signal: options.signal, redirect: options.redirect };
    state.calls.push(call);
    assert.equal(options.redirect, "manual");
    const custom = await state.onRequest?.(call, state);
    if (custom !== undefined) return custom;
    const path = url.pathname;
    if (url.origin === "https://api.github.com" && options.method === "GET") {
      if (path.startsWith(`${base}/git/commits/`)) { const sha = path.split("/").at(-1); return state.commitShas.has(sha) ? json({ sha }) : json({}, 404); }
      if (path === `${base}/git/ref/heads/main`) return state.mainCommit ? json({ ref: "refs/heads/main", object: { type: "commit", sha: state.mainCommit } }) : json({}, 404);
      if (path === `${base}/git/ref/heads/review/fixture`) return state.proposalCommit ? json({ ref: "refs/heads/review/fixture", object: { type: "commit", sha: state.proposalCommit } }) : json({}, 404);
      if (path.startsWith(`${base}/compare/`)) {
        const pair = path.split("/").at(-1); const [accepted] = pair.split("...");
        const ancestor = state.remoteAncestry.has(pair);
        return json({ base_commit: { sha: accepted }, merge_base_commit: { sha: ancestor ? accepted : "f".repeat(40) }, status: ancestor ? "ahead" : "diverged", ahead_by: 1, behind_by: ancestor ? 0 : 1 });
      }
      if (path.startsWith(`${base}/git/ref/tags/`)) return state.tagObject ? json({ ref: `refs/tags/${path.split("/").at(-1)}`, object: state.tagObject }) : json({}, 404);
      if (path.startsWith(`${base}/releases/tags/`)) return json(state.releases.find((r) => !r.draft && r.tag_name === path.split("/").at(-1)) ?? {}, state.releases.some((r) => !r.draft && r.tag_name === path.split("/").at(-1)) ? 200 : 404);
      if (path === `${base}/releases`) return json(state.releases.slice((Number(url.searchParams.get("page")) - 1) * 100, Number(url.searchParams.get("page")) * 100));
      const assetList = path.match(/\/releases\/(\d+)\/assets$/u);
      if (assetList) return json([...state.assets.values()].filter((a) => a.releaseId === Number(assetList[1])).slice((Number(url.searchParams.get("page")) - 1) * 100, Number(url.searchParams.get("page")) * 100));
      const download = path.match(/\/releases\/assets\/(\d+)$/u);
      if (download) return state.bytes.has(Number(download[1])) ? new Response(state.bytes.get(Number(download[1]))) : json({}, 404);
      const releaseGet = path.match(/\/releases\/(\d+)$/u);
      if (releaseGet) return json(state.releases.find((r) => r.id === Number(releaseGet[1])) ?? {}, state.releases.some((r) => r.id === Number(releaseGet[1])) ? 200 : 404);
    }
    if (url.origin === "https://api.github.com" && options.method === "POST" && path === `${base}/releases`) {
      const release = { ...JSON.parse(options.body), id: state.nextId++, immutable: false };
      release.upload_url = `https://uploads.github.com${base}/releases/${release.id}/assets{?name,label}`;
      state.releases.push(release);
      return json(release, 201);
    }
    if (url.origin === "https://uploads.github.com" && options.method === "POST") {
      if ([...state.assets.values()].some((asset) => asset.releaseId === Number(path.split("/").at(-2)) && asset.name === url.searchParams.get("name"))) return json({}, 422);
      const id = state.nextId++;
      const bytes = Buffer.from(options.body);
      const asset = { id, releaseId: Number(path.split("/").at(-2)), name: url.searchParams.get("name"), size: bytes.length, digest: `sha256:${sha256(bytes)}`, state: "uploaded" };
      state.assets.set(id, asset); state.bytes.set(id, bytes);
      return json(asset, 201);
    }
    if (url.origin === "https://api.github.com" && options.method === "PATCH") {
      const release = state.releases.find((r) => r.id === Number(path.split("/").at(-1)));
      Object.assign(release, JSON.parse(options.body), { immutable: state.immutable });
      state.tagObject ??= { type: "commit", sha: release.target_commitish };
      return json(release);
    }
    throw new Error("Unexpected fake request");
  };
  return { state, fetchImpl, store: (options = {}) => createGitHubReleaseStore({ owner: "fixture", repo: "audit", token, fetchImpl, ...options }) };
}
const optionsFor = (f) => ({ bundleDir: f.dir, targetCommit });
const mutations = (state) => state.calls.filter(({ method }) => method !== "GET");

async function seed(t, fakeOptions) {
  const f = await fixture(t);
  const gh = fakeGitHub(fakeOptions);
  await gh.store().stageBundle(optionsFor(f));
  // Pre-existing server fixture; staging itself never publishes.
  gh.state.releases[0].draft = false;
  gh.state.releases[0].immutable = gh.state.immutable;
  gh.state.tagObject = { type: "commit", sha: targetCommit };
  const receipt = await gh.store().verifyBundle(optionsFor(f));
  gh.state.calls.length = 0;
  return { ...f, ...gh, receipt };
}

test("preflight verifies canonical bundle bytes without changing candidate identity or semantics", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareAuditBundle(f.dir);
  assert.equal(prepared.bundleId, f.manifest.bundleId);
  assert.equal(prepared.manifestSha256, sha256(await readFile(join(f.dir, "manifest.json"))));
  assert.deepEqual(Object.keys(prepared.files).sort(), ["kg.json", "lifecycle.json.gz", "manifest.json"]);
  assert.equal(prepared.files["kg.json"].assetName, `${f.manifest.artifacts["kg.json"].sha256}-kg.json`);
  assert.ok(Object.isFrozen(prepared.files["kg.json"]));
});

test("preflight rejects noncanonical manifests, hashes, extra/source archive files, and unsafe files", async (t) => {
  const f = await fixture(t);
  const manifestPath = join(f.dir, "manifest.json");
  const original = await readFile(manifestPath);
  await writeFile(manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(prepareAuditBundle(f.dir), /canonical JSON/u);
  await writeFile(manifestPath, original);
  await writeFile(join(f.dir, "archive.tar"), "no raw archive");
  await assert.rejects(prepareAuditBundle(f.dir), /extra files/u);
  await rm(join(f.dir, "archive.tar"));
  await writeFile(join(f.dir, "kg.json"), "corruption");
  await assert.rejects(prepareAuditBundle(f.dir));
  await rm(join(f.dir, "kg.json"));
  await symlink(manifestPath, join(f.dir, "kg.json"));
  await assert.rejects(prepareAuditBundle(f.dir), /regular, unlinked/u);
  const outside = await fixture(t, { "source-archive.json": { source: "not allowed" } });
  await assert.rejects(prepareAuditBundle(outside.dir), /source archives/u);
  await symlink(f.dir, join(f.root, "linked"));
  await assert.rejects(prepareAuditBundle(join(f.root, "linked")), /canonical and real/u);
});

test("local byte limits apply before any request and cannot be enlarged", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub();
  await assert.rejects(gh.store({ limits: { fileBytes: 1 } }).stageBundle(optionsFor(f)), { code: "BYTE_LIMIT" });
  await assert.rejects(prepareAuditBundle(f.dir, { limits: { totalBytes: 1 } }), { code: "BYTE_LIMIT" });
  assert.equal(gh.state.calls.length, 0);
  assert.throws(() => gh.store({ limits: { fileBytes: AUDIT_STORE_LIMITS.fileBytes + 1 } }), /limit/u);
});

test("repository, target commit, and transport configuration must be explicit", async (t) => {
  assert.throws(() => createGitHubReleaseStore(), /owner/u);
  assert.throws(() => createGitHubReleaseStore({ owner: "fixture", repo: "../audit" }), /repository/u);
  assert.throws(() => createGitHubReleaseStore({ owner: "fixture", repo: "audit", token: "bad\ntoken" }), /token/u);
  assert.throws(() => createGitHubReleaseStore({ owner: "fixture", repo: "audit", timeoutMs: Infinity }), /timeout/u);
  const f = await fixture(t);
  const gh = fakeGitHub();
  await assert.rejects(gh.store().stageBundle({ ...optionsFor(f), targetCommit: "main" }), /full Git commit/u);
  assert.equal(gh.state.calls.length, 0);
});

test("staging uploads hash-addressed assets and reads them back without ever publishing", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub({ immutable: true });
  const receipt = await gh.store().stageBundle(optionsFor(f));
  assert.equal(receipt.bundleId, f.manifest.bundleId);
  assert.equal(receipt.targetCommit, targetCommit);
  assert.equal(receipt.tag, f.tag);
  assert.equal(receipt.repository, repository);
  assert.equal(receipt.githubImmutableAtReadback, false);
  assert.equal(receipt.visibilityAtReadback, "draft");
  assert.equal(receipt.readbackVerified, true);
  assert.equal(receipt.rawSourceArchiveIncluded, false);
  assert.match(receipt.sourceReplay, /does not guarantee raw upstream re-extraction/u);
  assert.equal(gh.state.releases[0].draft, true);
  assert.equal(gh.state.releases[0].make_latest, "false");
  assert.equal(gh.state.releases[0].prerelease, true);
  assert.equal(Object.hasOwn(receipt, "acceptanceCommit"), false);
  assert.equal(mutations(gh.state).length, 4);
  for (const call of gh.state.calls) assert.equal(call.headers.Authorization, `Bearer ${token}`);
  assert.equal(gh.state.calls.some(({ method }) => method === "PATCH"), false);
  assert.equal(typeof gh.store().publishBundle, "undefined");
  const readbacks = gh.state.calls.filter(({ url }) => /\/releases\/assets\/\d+$/u.test(url.pathname));
  assert.ok(readbacks.length >= 3);
  assert.deepEqual(Object.keys(receipt.assets).sort(), ["kg.json", "lifecycle.json.gz", "manifest.json"]);
  assert.ok(Object.isFrozen(receipt.assets["kg.json"]));
  assert.equal(JSON.stringify(receipt).includes(token), false);
});

test("rerun and verify are read-only with a fully matching published release", async (t) => {
  const f = await seed(t);
  const next = await f.store().stageBundle(optionsFor(f));
  assert.deepEqual(next, f.receipt);
  assert.deepEqual(await f.store().verifyBundle(optionsFor(f)), next);
  assert.equal(mutations(f.state).length, 0);
});

test("read-only verify never creates a missing release", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub();
  await assert.rejects(gh.store().verifyBundle(optionsFor(f)), { code: "NOT_FOUND" });
  assert.equal(mutations(gh.state).length, 0);
});

test("actual tag ref and existing repository commit must match even if release metadata does", async (t) => {
  const f = await seed(t);
  f.state.tagObject.sha = "b".repeat(40);
  await assert.rejects(f.store().stageBundle(optionsFor(f)), /different commit/u);
  assert.equal(mutations(f.state).length, 0);
  f.state.tagObject = { type: "tag", sha: "c".repeat(40) };
  f.state.onRequest = ({ url }) => url.pathname.endsWith(`/git/tags/${"c".repeat(40)}`) ? json({ sha: "c".repeat(40), object: { type: "commit", sha: targetCommit } }) : undefined;
  assert.deepEqual(await f.store().verifyBundle(optionsFor(f)), f.receipt);
  f.state.onRequest = ({ url }) => url.pathname.includes("/git/commits/") ? json({}, 404) : undefined;
  await assert.rejects(f.store().stageBundle(optionsFor(f)), { status: 404 });
  assert.equal(mutations(f.state).length, 0);
});

test("existing metadata, unexpected/missing assets, starter state, and hashes reject without mutation", async (t) => {
  for (const change of [
    (s) => { s.releases[0].body = "different bundle"; },
    (s) => { s.assets.values().next().value.digest = `sha256:${"f".repeat(64)}`; },
    (s) => { s.assets.values().next().value.state = "starter"; },
    (s) => { s.assets.values().next().value.name = "unapproved.tar"; },
    (s) => { s.assets.delete(s.assets.keys().next().value); },
  ]) {
    const f = await seed(t);
    change(f.state);
    await assert.rejects(f.store().stageBundle(optionsFor(f)), { code: "IMMUTABLE_CONFLICT" });
    assert.equal(mutations(f.state).length, 0);
  }
});

test("download hash is verified independently of matching metadata digest", async (t) => {
  const f = await seed(t);
  const id = f.state.assets.keys().next().value;
  f.state.bytes.set(id, Buffer.alloc(f.state.bytes.get(id).length, 65));
  await assert.rejects(f.store().verifyBundle(optionsFor(f)), { code: "READBACK_MISMATCH" });
  assert.equal(mutations(f.state).length, 0);
});

test("optional older asset digest is accepted only after exact byte readback", async (t) => {
  const f = await seed(t);
  for (const asset of f.state.assets.values()) delete asset.digest;
  assert.equal((await f.store().verifyBundle(optionsFor(f))).readbackVerified, true);
});

test("successful creation is independently read by ID while draft tag/list visibility lags", async (t) => {
  const f = await fixture(t);
  const durable = new Set(); let createConfirmed = false;
  const gh = fakeGitHub({ onRequest: ({ url, method }, state) => {
    if (method === "GET" && url.pathname === `${base}/releases` && state.releases.length) return json([]);
  } });
  const receipt = await gh.store({
    onMutationIntent: ({ operation }) => durable.add(operation),
    onMutationReconciled: ({ operation, action }) => {
      if (action === "create") {
        assert.ok(durable.has(operation));
        assert.ok(gh.state.calls.some(({ url, method }) => method === "GET" && url.pathname === `${base}/releases/${gh.state.releases[0].id}`));
        assert.equal(gh.state.assets.size, 0);
        createConfirmed = true;
      }
      durable.delete(operation);
    },
  }).stageBundle(optionsFor(f));
  assert.equal(receipt.releaseId, gh.state.releases[0].id);
  assert.equal(receipt.readbackVerified, true);
  assert.equal(receipt.visibilityAtReadback, "draft");
  assert.equal(createConfirmed, true);
  assert.equal(durable.size, 0);
  assert.equal(mutations(gh.state).filter(({ url }) => url.origin === "https://api.github.com").length, 1);
  assert.equal(mutations(gh.state).length, 4);
});

test("creation readback retries only reads after direct-ID absence or transient failures", async (t) => {
  for (const failure of [404, 503, "transport", "timeout"]) {
    const f = await fixture(t); let reads = 0; let createConfirmed = false;
    const gh = fakeGitHub({ onRequest: ({ url, method }) => {
      if (!createConfirmed && method === "GET" && /\/releases\/\d+$/u.test(url.pathname)) {
        reads++;
        if (reads === 1) {
          if (failure === "transport") throw new Error(token);
          if (failure === "timeout") return new Promise(() => {});
          return json({}, failure);
        }
      }
    } });
    const receipt = await gh.store({ timeoutMs: failure === "timeout" ? 100 : 30_000, onMutationReconciled: ({ action }) => {
      if (action === "create") { assert.equal(reads, 2); createConfirmed = true; }
    } }).stageBundle(optionsFor(f));
    assert.equal(receipt.readbackVerified, true);
    assert.equal(mutations(gh.state).length, 4);
    assert.equal(gh.state.releases.length, 1);
  }
});

test("lost creation response tolerates eventual list discovery without a second POST", async (t) => {
  const f = await fixture(t); let afterCreateLists = 0;
  const gh = fakeGitHub({ onRequest: ({ url, method }, state) => {
    if (method === "GET" && url.pathname === `${base}/releases` && state.releases.length && ++afterCreateLists <= 2) return json([]);
  } });
  const fetchImpl = async (url, options) => {
    const response = await gh.fetchImpl(url, options);
    if (options.method === "POST" && url === `https://api.github.com${base}/releases`) throw new Error(token);
    return response;
  };
  assert.equal((await gh.store({ fetchImpl }).stageBundle(optionsFor(f))).readbackVerified, true);
  assert.equal(afterCreateLists, 3);
  assert.equal(gh.state.releases.length, 1);
  assert.equal(mutations(gh.state).length, 4);
});

test("exhausted creation readback retains intent and blocks duplicate writes across calls and restart", async (t) => {
  const f = await fixture(t); const durable = new Set(); let reads = 0;
  const gh = fakeGitHub({ onRequest: ({ url, method }, state) => {
    if (method !== "GET" || !state.releases.length) return;
    if (url.pathname === `${base}/releases`) return json([]);
    if (/\/releases\/\d+$/u.test(url.pathname)) { reads++; return json({}, 404); }
  } });
  const hooks = { onMutationIntent: ({ operation }) => durable.add(operation), onMutationReconciled: ({ operation }) => durable.delete(operation) };
  const store = gh.store(hooks);
  await assert.rejects(store.stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION", operation: `${f.tag}:create` });
  assert.equal(reads, 4);
  assert.deepEqual([...durable], [`${f.tag}:create`]);
  await assert.rejects(store.stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
  const resumed = gh.store({ ...hooks, pendingOperations: [...durable] });
  await assert.rejects(resumed.stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
  assert.equal(mutations(gh.state).length, 1);
  assert.equal(gh.state.assets.size, 0);
  gh.state.onRequest = undefined;
  assert.deepEqual((await resumed.reconcilePending(optionsFor(f))).outcomes, [{ operation: `${f.tag}:create`, state: "confirmed" }]);
  assert.equal(durable.size, 0);
  assert.equal(mutations(gh.state).length, 1);
});

test("four transient creation readback failures exhaust the bound without clearing intent", async (t) => {
  const f = await fixture(t); let reads = 0; const durable = new Set();
  const gh = fakeGitHub({ onRequest: ({ url, method }) => {
    if (method === "GET" && /\/releases\/\d+$/u.test(url.pathname)) { reads++; return json({}, 503); }
  } });
  await assert.rejects(gh.store({
    onMutationIntent: ({ operation }) => durable.add(operation),
    onMutationReconciled: ({ operation }) => durable.delete(operation),
  }).stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
  assert.equal(reads, 4);
  assert.deepEqual([...durable], [`${f.tag}:create`]);
  assert.equal(mutations(gh.state).length, 1);
  assert.equal(gh.state.assets.size, 0);
});

test("malformed or conflicting creation responses never become trusted ID locators", async (t) => {
  for (const change of [
    (r) => { r.id = "10/../../outside"; },
    (r) => { r.id = 0; },
    (r) => { r.id = Number.MAX_SAFE_INTEGER + 1; },
    (r) => { r.body = "wrong bundle"; },
    (r) => { r.target_commitish = "b".repeat(40); },
    (r) => { r.upload_url = "https://outside.example/upload"; },
  ]) {
    const f = await fixture(t); const gh = fakeGitHub(); const durable = new Set();
    const fetchImpl = async (url, options) => {
      const response = await gh.fetchImpl(url, options);
      if (options.method !== "POST" || url !== `https://api.github.com${base}/releases`) return response;
      const metadata = await response.json(); change(metadata); return json(metadata, 201);
    };
    await assert.rejects(gh.store({ fetchImpl, onMutationIntent: ({ operation }) => durable.add(operation), onMutationReconciled: ({ operation }) => durable.delete(operation) }).stageBundle(optionsFor(f)), (error) => ["IMMUTABLE_CONFLICT", "UNSAFE_URL"].includes(error.code));
    assert.equal(mutations(gh.state).length, 1);
    assert.deepEqual([...durable], [`${f.tag}:create`]);
    assert.equal(gh.state.calls.some(({ url }) => /\/releases\/\d+$/u.test(url.pathname)), false);
    assert.ok(gh.state.calls.every(({ url }) => url.origin === "https://api.github.com"));
  }
});

test("direct creation readback rejects changed IDs, metadata, target refs and unsafe URLs without retry", async (t) => {
  for (const change of [
    (r) => { r.id++; r.upload_url = `https://uploads.github.com${base}/releases/${r.id}/assets`; },
    (r) => { r.body = "changed"; },
    (r) => { r.target_commitish = "b".repeat(40); },
    (r) => { r.upload_url = "https://outside.example/upload"; },
    (r, state) => { state.tagObject = { type: "commit", sha: "b".repeat(40) }; },
  ]) {
    const f = await fixture(t); let reads = 0; const confirmed = [];
    const gh = fakeGitHub({ onRequest: ({ url, method }, state) => {
      if (method === "GET" && /\/releases\/\d+$/u.test(url.pathname)) {
        reads++; const metadata = structuredClone(state.releases[0]); change(metadata, state); return json(metadata);
      }
    } });
    await assert.rejects(gh.store({ onMutationReconciled: (operation) => confirmed.push(operation) }).stageBundle(optionsFor(f)), (error) => ["IMMUTABLE_CONFLICT", "UNSAFE_URL"].includes(error.code));
    assert.equal(reads, 1);
    assert.equal(mutations(gh.state).length, 1);
    assert.deepEqual(confirmed, []);
  }
});

test("successful ID readback cannot bypass a visible conflicting or duplicate tag", async (t) => {
  for (const duplicate of [false, true]) {
    const f = await fixture(t);
    const gh = fakeGitHub({ onRequest: ({ url, method }, state) => {
      if (method === "GET" && url.pathname === `${base}/releases` && state.releases.length) {
        const other = { ...state.releases[0], id: 999, upload_url: `https://uploads.github.com${base}/releases/999/assets` };
        return json(duplicate ? [state.releases[0], other] : [other]);
      }
    } });
    await assert.rejects(gh.store().stageBundle(optionsFor(f)), { code: "IMMUTABLE_CONFLICT" });
    assert.equal(mutations(gh.state).length, 1);
  }
});

test("creation readback does not retry authorization, invalid response or pagination failures", async (t) => {
  for (const failure of [403, 429, "invalid-json", "pagination"]) {
    const f = await fixture(t); let reads = 0;
    const gh = fakeGitHub({ onRequest: ({ url, method }, state) => {
      if (method !== "GET" || !state.releases.length) return;
      if (/\/releases\/\d+$/u.test(url.pathname)) {
        reads++;
        if (typeof failure === "number") return json({}, failure);
        if (failure === "invalid-json") return new Response("not JSON");
      }
      if (failure === "pagination" && url.pathname === `${base}/releases`) return json(Array.from({ length: 100 }, () => ({ tag_name: "unrelated" })));
    } });
    await assert.rejects(gh.store({ limits: { pages: 1 } }).stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
    assert.equal(reads, 1);
    assert.equal(mutations(gh.state).length, 1);
  }
});

test("uncertain create and upload are reconciled by reads without duplicate mutations", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub();
  const realFake = gh.fetchImpl;
  const failOnce = new Set(["create", "upload"]);
  const fetchImpl = async (url, options) => {
    const response = await realFake(url, options);
    const kind = options.method === "PATCH" ? "publish" : options.method === "POST" ? (url.startsWith("https://uploads.") ? "upload" : "create") : null;
    if (failOnce.has(kind)) { failOnce.delete(kind); throw new Error(`Sensitive transport detail ${token}`); }
    return response;
  };
  const receipt = await gh.store({ fetchImpl }).stageBundle(optionsFor(f));
  assert.equal(receipt.readbackVerified, true);
  assert.equal(mutations(gh.state).length, 4);
  assert.equal(failOnce.size, 0);
});

test("unresolved mutation stops and later calls on same adapter reconcile before any retry", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub({ onRequest: ({ method }) => method === "POST" ? json({}, 502) : undefined });
  const store = gh.store();
  await assert.rejects(store.stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
  assert.equal(mutations(gh.state).length, 1);
  gh.state.onRequest = undefined;
  await assert.rejects(store.stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
  assert.equal(mutations(gh.state).length, 1);
});

test("starter asset from failed upload is never implicitly deleted or replaced", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub({ onRequest: ({ url, method, body }, state) => {
    if (url.origin !== "https://uploads.github.com" || method !== "POST") return;
    const id = state.nextId++;
    state.assets.set(id, { id, releaseId: state.releases[0].id, name: url.searchParams.get("name"), size: Buffer.byteLength(body), state: "starter" });
    return json({}, 502);
  } });
  await assert.rejects(gh.store().stageBundle(optionsFor(f)), { code: "IMMUTABLE_CONFLICT" });
  assert.equal(mutations(gh.state).length, 2);
  assert.equal(gh.state.calls.some(({ method }) => method === "DELETE" || method === "PATCH"), false);
});

test("malicious upload URL and download redirects never receive credentials", async (t) => {
  const f = await seed(t);
  f.state.releases[0].upload_url = "https://evil.example/upload{?name,label}";
  await assert.rejects(f.store().verifyBundle(optionsFor(f)), { code: "UNSAFE_URL" });
  assert.equal(f.state.calls.some(({ url }) => url.hostname === "evil.example"), false);
  f.state.releases[0].upload_url = `https://uploads.github.com${base}/releases/${f.state.releases[0].id}/assets{?name,label}`;
  f.state.onRequest = ({ url }) => /\/releases\/assets\/\d+$/u.test(url.pathname) ? new Response(null, { status: 302, headers: { location: "https://evil.example/capture" } }) : undefined;
  await assert.rejects(f.store().verifyBundle(optionsFor(f)), { code: "UNSAFE_URL" });
  assert.equal(f.state.calls.some(({ url }) => url.hostname === "evil.example"), false);
});

test("trusted GitHub binary redirects are manual, bounded, and strip authorization", async (t) => {
  const f = await seed(t);
  f.state.onRequest = ({ url, headers }, state) => {
    const match = url.pathname.match(/\/releases\/assets\/(\d+)$/u);
    if (match) return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/download/${match[1]}?signature=private` } });
    if (url.hostname === "release-assets.githubusercontent.com") {
      assert.equal(headers.Authorization, undefined);
      return new Response(state.bytes.get(Number(url.pathname.split("/").at(-1))));
    }
  };
  const receipt = await f.store().verifyBundle(optionsFor(f));
  assert.equal(receipt.readbackVerified, true);
  assert.equal(JSON.stringify(receipt).includes("signature="), false);
});

test("oversized metadata, oversized downloads, and stalled requests fail with bounded safe errors", async (t) => {
  const f = await fixture(t);
  const oversized = fakeGitHub({ onRequest: () => new Response("x".repeat(30), { headers: { "content-length": "30" } }) });
  await assert.rejects(oversized.store({ limits: { metadataBytes: 20 } }).stageBundle(optionsFor(f)), { code: "BYTE_LIMIT" });
  const existing = await seed(t);
  existing.state.onRequest = ({ url }) => /\/releases\/assets\/\d+$/u.test(url.pathname) ? new Response(Buffer.alloc(100_000)) : undefined;
  await assert.rejects(existing.store().verifyBundle(optionsFor(existing)), { code: "BYTE_LIMIT" });
  const stalled = fakeGitHub({ onRequest: () => new Promise(() => {}) });
  await assert.rejects(stalled.store({ timeoutMs: 10 }).stageBundle(optionsFor(f)), { code: "REQUEST_TIMEOUT" });
  const throwing = fakeGitHub({ onRequest: () => { throw new Error(token); } });
  await assert.rejects(throwing.store().stageBundle(optionsFor(f)), (error) => error.code === "REQUEST_FAILED" && !String(error).includes(token) && !error.cause);
});

test("pagination does not interpret a bounded incomplete list as absence", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub({ onRequest: ({ url }) => url.pathname === `${base}/releases` ? json(Array.from({ length: 100 }, (_, id) => ({ id, tag_name: `other-${id}` }))) : undefined });
  await assert.rejects(gh.store({ limits: { pages: 1 } }).stageBundle(optionsFor(f)), { code: "PAGE_LIMIT" });
  assert.equal(mutations(gh.state).length, 0);
});

test("local changes after preflight fail before uploading the changed asset", async (t) => {
  const f = await fixture(t);
  let changed = false;
  const gh = fakeGitHub({ onRequest: async ({ url }) => {
    if (!changed && url.pathname.endsWith(`/git/commits/${targetCommit}`)) {
      changed = true;
      await writeFile(join(f.dir, "kg.json"), "bad");
    }
  } });
  await assert.rejects(gh.store().stageBundle(optionsFor(f)), /changed before upload/u);
  assert.equal(gh.state.calls.some(({ method }) => method === "PATCH"), false);
});

test("hardlinked artifacts and missing/changed manifest bindings fail before network use", async (t) => {
  const f = await fixture(t);
  await link(join(f.dir, "kg.json"), join(f.root, "kg-link.json"));
  await assert.rejects(prepareAuditBundle(f.dir), /regular, unlinked/u);
  await rm(join(f.root, "kg-link.json"));
  const manifest = JSON.parse(await readFile(join(f.dir, "manifest.json"), "utf8"));
  manifest.bundleId = "f".repeat(64);
  await writeFile(join(f.dir, "manifest.json"), `${canonicalJson(manifest)}\n`);
  await assert.rejects(prepareAuditBundle(f.dir), /bundleId does not bind/u);
});

test("known HTTP errors retain only safe status when read-only reconciliation finds no mutation", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub({ onRequest: ({ method }) => method === "POST" ? json({ message: token }, 403) : undefined });
  await assert.rejects(gh.store().stageBundle(optionsFor(f)), (error) => {
    assert.equal(error.code, "UNCERTAIN_MUTATION");
    assert.equal(error.requestStatus, 403);
    assert.equal(error.requestCode, "HTTP_ERROR");
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
});

test("create and upload use the same explicit bearer with manual redirects", async (t) => {
  const f = await fixture(t); const gh = fakeGitHub();
  await gh.store().stageBundle(optionsFor(f));
  const writes = mutations(gh.state);
  assert(writes.some(({ url }) => url.origin === "https://api.github.com"));
  assert(writes.some(({ url }) => url.origin === "https://uploads.github.com"));
  for (const call of writes) {
    assert.equal(call.headers.Authorization, `Bearer ${token}`);
    assert.equal(call.redirect, "manual");
  }
});

test("upload 401 retains safe diagnostics and pending intent across restart without retry", async (t) => {
  const f = await fixture(t); const durable = new Set();
  const requestId = "E385:35E2EC:1105D7:1D1490:6AC8C358";
  const gh = fakeGitHub({ onRequest: ({ url, method }) => {
    if (url.origin === "https://uploads.github.com" && method === "POST") return new Response(token,
      { status: 401, headers: { "x-github-request-id": requestId, "x-secret": token } });
  } });
  const hooks = { onMutationIntent: ({ operation }) => durable.add(operation), onMutationReconciled: ({ operation }) => durable.delete(operation) };
  await assert.rejects(gh.store(hooks).stageBundle(optionsFor(f)), (error) => {
    assert.equal(error.code, "UNCERTAIN_MUTATION");
    assert.equal(error.requestStatus, 401);
    assert.equal(error.requestHost, "uploads.github.com");
    assert.equal(error.requestMethod, "POST");
    assert.equal(error.githubRequestId, requestId);
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
  assert.equal(durable.size, 1);
  assert.equal(gh.state.releases.length, 1);
  assert.equal(gh.state.assets.size, 0);
  const before = mutations(gh.state).length;
  const resumed = gh.store({ ...hooks, pendingOperations: [...durable] });
  assert.deepEqual((await resumed.reconcilePending(optionsFor(f))).outcomes.map(({ state }) => state), ["unknown"]);
  await assert.rejects(resumed.stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
  assert.equal(mutations(gh.state).length, before);
  assert.equal(durable.size, 1);
});

test("upload intent can fail in its preflight GET before any upload POST", async (t) => {
  const f = await fixture(t); let uploadIntent = false;
  const gh = fakeGitHub({ onRequest: ({ url, method }) => uploadIntent && method === "GET"
    && /\/releases\/\d+$/u.test(url.pathname) ? json({}, 401) : undefined });
  await assert.rejects(gh.store({ onMutationIntent: ({ action }) => { if (action === "upload") uploadIntent = true; } })
    .stageBundle(optionsFor(f)), (error) => {
    assert.equal(error.code, "UNCERTAIN_MUTATION");
    assert.match(error.operation, /:upload:/u);
    assert.equal(error.requestStatus, 401);
    assert.equal(error.requestHost, "api.github.com");
    assert.equal(error.requestMethod, "GET");
    return true;
  });
  assert.equal(gh.state.calls.filter(({ url, method }) => url.origin === "https://uploads.github.com" && method === "POST").length, 0);
});

test("HTTP diagnostics exclude arbitrary headers and credential-shaped request IDs", async (t) => {
  const f = await fixture(t);
  for (const requestId of [token, "A".repeat(1024), "https://example.invalid/private", "ABCD:1234:ABCD:1234:ABCD"]) {
    const gh = fakeGitHub({ onRequest: ({ method }) => method === "POST"
      ? new Response("private response", { status: 401, headers: { "x-github-request-id": requestId } }) : undefined });
    await assert.rejects(gh.store({ token: requestId }).stageBundle(optionsFor(f)), (error) => {
      assert.equal(error.githubRequestId, undefined);
      assert.equal(error.requestHost, "api.github.com");
      assert.equal(JSON.stringify(error).includes(requestId), false);
      return true;
    });
  }
});

test("upload uncertainty with no asset stops and is not retried", async (t) => {
  for (const operation of ["upload"]) {
    const f = await fixture(t);
    const gh = fakeGitHub({ onRequest: ({ method, url }) => (operation === "upload" ? url.origin === "https://uploads.github.com" : method === "PATCH") ? json({}, 502) : undefined });
    const store = gh.store();
    await assert.rejects(store.stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
    const count = mutations(gh.state).length;
    gh.state.onRequest = undefined;
    await assert.rejects(store.stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
    assert.equal(mutations(gh.state).length, count);
    assert.equal(gh.state.releases[0].draft, true);
  }
});

test("draft metadata modified during upload preparation cannot be published", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub({ onRequest: ({ method, url }, state) => {
    if (method === "GET" && /\/releases\/\d+$/u.test(url.pathname)) state.releases[0].body = "changed";
  } });
  await assert.rejects(gh.store().stageBundle(optionsFor(f)), { code: "IMMUTABLE_CONFLICT" });
  assert.equal(mutations(gh.state).length, 1);
});

test("asset replacement during readback is detected even if metadata and content match", async (t) => {
  const f = await seed(t);
  let changed = false;
  f.state.onRequest = ({ url }, state) => {
    if (!changed && /\/releases\/assets\/\d+$/u.test(url.pathname)) {
      changed = true;
      const id = Number(url.pathname.split("/").at(-1));
      const body = state.bytes.get(id);
      const asset = state.assets.get(id);
      state.assets.delete(id); state.assets.set(id + 100, { ...asset, id: id + 100 });
      state.bytes.set(id + 100, body);
      return new Response(body);
    }
  };
  await assert.rejects(f.store().verifyBundle(optionsFor(f)), /changed during readback/u);
});

test("durable intent and reconciliation hooks are awaited and expose only safe binding metadata", async (t) => {
  const f = await fixture(t);
  const durable = new Set(); const intents = []; const confirmed = [];
  const gh = fakeGitHub({ onRequest: ({ method, url }) => {
    if (method !== "GET") {
      const suffix = method === "PATCH" ? "publish" : url.origin === "https://uploads.github.com" ? `upload:${url.searchParams.get("name")}` : "create";
      assert.ok(durable.has(`${f.tag}:${suffix}`), "intent must be durable before mutation");
    }
  } });
  const store = gh.store({
    onMutationIntent: async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.ok(Object.isFrozen(entry));
      assert.equal(entry.repository, repository);
      assert.equal(entry.targetCommit, targetCommit);
      assert.equal(entry.tag, f.tag);
      assert.equal(JSON.stringify(entry).includes(token), false);
      assert.equal(Object.hasOwn(entry, "body"), false);
      intents.push(entry); durable.add(entry.operation);
    },
    onMutationReconciled: async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      confirmed.push(entry.operation); durable.delete(entry.operation);
    },
  });
  await store.stageBundle(optionsFor(f));
  assert.equal(intents.length, 4);
  assert.deepEqual(confirmed, intents.map((entry) => entry.operation));
  assert.equal(durable.size, 0);
  for (const entry of intents.filter(({ action }) => action === "upload")) {
    assert.equal(entry.asset.name.split("-")[0], entry.asset.sha256);
    assert.ok(Number.isSafeInteger(entry.asset.bytes));
    assert.ok(Number.isSafeInteger(entry.releaseId));
  }
});

test("failed intent hook sends no mutation and sanitizes callback secrets", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub();
  await assert.rejects(gh.store({ onMutationIntent: () => { throw new Error(token); } }).stageBundle(optionsFor(f)), (error) => error.code === "JOURNAL_ERROR" && !String(error).includes(token));
  assert.equal(mutations(gh.state).length, 0);
});

test("failed confirmation hook leaves a recoverable journal entry and never repeats successful POST", async (t) => {
  const f = await fixture(t);
  const gh = fakeGitHub();
  const pending = new Set();
  await assert.rejects(gh.store({
    onMutationIntent: ({ operation }) => pending.add(operation),
    onMutationReconciled: () => { throw new Error("journal unavailable"); },
  }).stageBundle(optionsFor(f)), { code: "JOURNAL_ERROR" });
  assert.equal(mutations(gh.state).length, 1);
  const resumed = gh.store({ pendingOperations: [...pending], onMutationReconciled: ({ operation }) => pending.delete(operation) });
  const result = await resumed.reconcilePending(optionsFor(f));
  assert.deepEqual(result.outcomes, [{ operation: `${f.tag}:create`, state: "confirmed" }]);
  assert.deepEqual(result.pendingOperations, []);
  assert.equal(pending.size, 0);
  assert.equal(mutations(gh.state).length, 1);
  await resumed.stageBundle(optionsFor(f));
  assert.equal(mutations(gh.state).filter(({ url, method }) => method === "POST" && url.origin === "https://api.github.com").length, 1);
});

test("restored unknown mutation journals stay unknown and block every write after restart", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareAuditBundle(f.dir);
  const operations = [`${f.tag}:create`, `${f.tag}:upload:${prepared.files["kg.json"].assetName}`, `${f.tag}:publish`];
  const gh = fakeGitHub();
  const store = gh.store({ pendingOperations: operations });
  const reconciliation = await store.reconcilePending(optionsFor(f));
  assert.deepEqual(reconciliation.outcomes.map(({ state }) => state), ["unknown", "unknown", "unknown"]);
  assert.deepEqual(reconciliation.pendingOperations, [...operations].sort());
  await assert.rejects(store.stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
  assert.equal(mutations(gh.state).length, 0);
});

test("read-only reconciliation clears only positively hash-verified stored operations", async (t) => {
  const f = await seed(t);
  const operations = [`${f.tag}:create`, `${f.tag}:upload:${f.receipt.assets["kg.json"].name}`, `${f.tag}:publish`];
  const store = f.store({ pendingOperations: operations });
  const result = await store.reconcilePending(optionsFor(f));
  assert.equal(result.outcomes.every(({ state }) => state === "confirmed"), true);
  assert.deepEqual(result.pendingOperations, []);
  assert.equal(mutations(f.state).length, 0);
  f.state.bytes.set(f.receipt.assets["kg.json"].id, Buffer.alloc(f.receipt.assets["kg.json"].bytes, 65));
  const corrupted = f.store({ pendingOperations: operations });
  const failed = await corrupted.reconcilePending(optionsFor(f));
  assert.deepEqual(failed.outcomes.map(({ state }) => state), ["confirmed", "unknown", "unknown"]);
  assert.equal(failed.outcomes[1].code, "READBACK_MISMATCH");
  assert.equal(failed.pendingOperations.length, 2);
  assert.equal(mutations(f.state).length, 0);
});

test("journal operation keys and callbacks are validated before mutations", async (t) => {
  assert.throws(() => createGitHubReleaseStore({ owner: "fixture", repo: "audit", pendingOperations: ["anything"] }), /pending/u);
  assert.throws(() => createGitHubReleaseStore({ owner: "fixture", repo: "audit", onMutationIntent: true }), /journal/u);
  const f = await fixture(t);
  const gh = fakeGitHub();
  const invalidBinding = `${f.tag}:upload:${"f".repeat(64)}-kg.json`;
  await assert.rejects(gh.store({ pendingOperations: [invalidBinding] }).reconcilePending(optionsFor(f)), /does not match bundle bindings/u);
  assert.equal(mutations(gh.state).length, 0);
});

test("readBundle restores exact manifest/artifact bytes without local candidate or filesystem writes", async (t) => {
  const f = await seed(t, { immutable: true });
  const expected = new Map(await Promise.all(Object.keys(f.receipt.assets).map(async (name) => [name, await readFile(join(f.dir, name))])));
  await rm(f.dir, { recursive: true });
  const recovered = await f.store().readBundle({ receipt: f.receipt });
  assert.deepEqual(recovered.manifest, f.manifest);
  assert.ok(Object.isFrozen(recovered.manifest));
  assert.ok(recovered.files instanceof Map);
  assert.deepEqual([...recovered.files.keys()].sort(), [...expected.keys()].sort());
  for (const [name, bytes] of expected) assert.ok(bytes.equals(recovered.files.get(name)));
  await assert.rejects(readFile(join(f.dir, "manifest.json")), { code: "ENOENT" });
  assert.equal(mutations(f.state).length, 0);
});

test("readBundle rejects malformed, wrong-repository and oversize receipts before any request", async (t) => {
  const f = await seed(t);
  for (const change of [
    (r) => { r.repository = "other/repo"; },
    (r) => { r.targetCommit = "main"; },
    (r) => { r.tag = "floating"; },
    (r) => { r.assets["kg.json"].bytes = Number.MAX_SAFE_INTEGER; },
    (r) => { r.assets["manifest.json"].sha256 = "f".repeat(64); },
    (r) => { r.assets["kg.json"].url = "https://evil.example/data"; },
    (r) => { r.assets["archive.tar"] = r.assets["kg.json"]; },
  ]) {
    const receipt = structuredClone(f.receipt); change(receipt);
    await assert.rejects(f.store().readBundle({ receipt }));
    assert.equal(f.state.calls.length, 0);
  }
});

test("readBundle binds exact asset and release IDs, complete inventory, immutable state, and byte hashes", async (t) => {
  const f = await seed(t);
  const wrongId = structuredClone(f.receipt);
  wrongId.assets["kg.json"].id += 100;
  await assert.rejects(f.store().readBundle({ receipt: wrongId }), /asset ID changed/u);
  const missing = structuredClone(f.receipt); delete missing.assets["kg.json"];
  await assert.rejects(f.store().readBundle({ receipt: missing }), /unexpected or duplicate assets/u);
  const changedImmutable = structuredClone(f.receipt); changedImmutable.githubImmutableAtReadback = true;
  await assert.rejects(f.store().readBundle({ receipt: changedImmutable }), /publication state changed/u);
  const wrongRelease = structuredClone(f.receipt); wrongRelease.releaseId += 100;
  await assert.rejects(f.store().readBundle({ receipt: wrongRelease }), { status: 404 });
  f.state.bytes.set(f.receipt.assets["kg.json"].id, Buffer.alloc(f.receipt.assets["kg.json"].bytes, 65));
  await assert.rejects(f.store().readBundle({ receipt: f.receipt }), { code: "READBACK_MISMATCH" });
  assert.equal(mutations(f.state).length, 0);
});

test("readBundle supports safe binary redirects without forwarding the token", async (t) => {
  const f = await seed(t);
  f.state.onRequest = ({ url, headers }, state) => {
    const match = url.pathname.match(/\/releases\/assets\/(\d+)$/u);
    if (match) return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/${match[1]}` } });
    if (url.hostname === "release-assets.githubusercontent.com") {
      assert.equal(headers.Authorization, undefined);
      return new Response(state.bytes.get(Number(url.pathname.slice(1))));
    }
  };
  const recovered = await f.store().readBundle({ receipt: f.receipt });
  assert.equal(recovered.files.size, 3);
  assert.equal(mutations(f.state).length, 0);
});

const execFile = promisify(execFileCallback);
async function fixtureGit(root, args) {
  return (await execFile("git", ["-C", root, ...args], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })).stdout.trim();
}
async function fixtureCommit(root) {
  await fixtureGit(root, ["add", "data"]);
  await fixtureGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture accepted checkpoint"]);
  return fixtureGit(root, ["rev-parse", "HEAD"]);
}
async function acceptedFixture(t, { immutable = true } = {}) {
  const f = await fixture(t, { "kg.json": {}, "news.json": {}, "lifecycle.json.gz": {}, "provenance.json.gz": {}, "source-review.json": null, "diff.json": {} });
  const paths = { acceptedState: "data/archive-state.json", acceptedKG: "data/generated/kg.json", acceptedNews: "data/processed/news.json" };
  await fixtureGit(f.root, ["init", "-q"]);
  await fixtureGit(f.root, ["remote", "add", "origin", `https://github.com/${repository}.git`]);
  const originBindings = {};
  for (const [name, path] of Object.entries(paths)) {
    await mkdir(join(f.root, path, ".."), { recursive: true });
    const content = Buffer.from(`${canonicalJson(name === "acceptedState" ? { schemaVersion: 3 } : {})}\n`);
    await writeFile(join(f.root, path), content);
    originBindings[name] = { path, sha256: sha256(content) };
  }
  const codeCommit = await fixtureCommit(f.root);
  const gh = fakeGitHub({ immutable });
  gh.state.commitShas.add(codeCommit);
  const staged = await gh.store().stageBundle({ bundleDir: f.dir, targetCommit: codeCommit });
  const versions = Object.fromEntries(["candidate", "lifecycle", "ontology", "extraction", "news", "segmentation", "overrides", "compiler", "node", "icu"].map((name) => [name, "fixture-v1"]));
  const configPaths = { ontologySource: "data/ontology-source.json", ontology: "data/ontology.json", patterns: "data/extraction-patterns.json", rules: "data/extraction-rules.json", newsOverrides: "data/news-overrides.json", compiler: "scripts/lib/ontology-compiler.mjs", segmentation: "scripts/lib/news.mjs" };
  const configuration = Object.fromEntries(Object.entries(configPaths).map(([name, path]) => [name, { path, sha256: sha256(name) }]));
  const generatorFiles = { "scripts/lib/kg-build.mjs": sha256("fixture generator") };
  configuration.generator = { files: generatorFiles, sha256: sha256(canonicalJson(generatorFiles)) };
  const runtimeFields = { node: versions.node, icu: versions.icu, v8: "fixture", unicode: "fixture", locale: "en-US", timeZone: "UTC" };
  const runtime = { ...runtimeFields, sha256: sha256(canonicalJson(runtimeFields)) };
  const source = { repository: { name: "fixture/source", url: "https://github.com/fixture/source", submodulePath: "sources/bedtimenews-archive-contents" }, commit: codeCommit, includedRoots: ["daily"], durableRawSource: false };
  const acceptedFiles = {};
  for (const [name, path] of Object.entries(paths)) {
    const content = Buffer.from(`${canonicalJson(name === "acceptedState" ? { schemaVersion: 4 } : {})}\n`);
    await writeFile(join(f.root, path), content);
    acceptedFiles[path] = { sha256: sha256(content), bytes: content.length };
  }
  const origin = { commit: codeCommit, bindings: originBindings };
  const manifest = { schemaVersion: 1, kind: "accepted-release", mode: "bootstrap", transition: null, origin, predecessor: null, rollbackTarget: null,
    candidateBundleId: f.manifest.bundleId, candidateManifestHash: sha256(canonicalJson(f.manifest)), codeCommit,
    versions, configuration, runtime, source,
    inventories: { observed: { sha256: sha256("{}"), fileCount: 0 }, effective: { sha256: sha256("{}"), fileCount: 0 }, sourceStatesHash: sha256("{}") },
    acceptedFiles, auditReceipt: staged };
  manifest.epochId = sha256(canonicalJson({ origin, versions, configuration, runtime, sourceRepository: source.repository, includedRoots: source.includedRoots }));
  manifest.releaseId = acceptedReleaseIdentity(manifest);
  validateAcceptedReleaseStructure(manifest);
  await writeFile(join(f.root, "data/accepted-release.json"), `${canonicalJson(manifest)}\n`);
  await fixtureGit(f.root, ["update-index", "--add", "--cacheinfo", `160000,${codeCommit},${source.repository.submodulePath}`]);
  const acceptedCommit = await fixtureCommit(f.root);
  await fixtureGit(f.root, ["update-ref", "refs/remotes/origin/main", acceptedCommit]);
  const checkpoint = await loadAcceptedGitCheckpoint({ root: f.root, repository, commit: acceptedCommit });
  gh.state.mainCommit = acceptedCommit;
  gh.state.commitShas.add(acceptedCommit);
  gh.state.calls.length = 0;
  return { ...f, ...gh, staged, checkpoint, acceptedCommit, codeCommit };
}

test("publication rejects booleans, raw receipts and local capability lookalikes before any request", async (t) => {
  const f = await fixture(t); const gh = fakeGitHub();
  for (const checkpoint of [true, {}, { repository, commit: targetCommit }, { receipt: f.manifest }]) {
    await assert.rejects(gh.store().publishAcceptedBundle({ checkpoint }), /not a capability/u);
  }
  assert.equal(gh.state.calls.length, 0);
});

test("an accepted Git checkpoint on actual remote main permits publishing only its exact staged release", async (t) => {
  const f = await acceptedFixture(t);
  assert.equal(f.state.releases[0].draft, true);
  assert.equal(f.state.tagObject, null);
  const before = await f.store().readBundle({ receipt: f.staged });
  const publicReceipt = await f.store().publishAcceptedBundle({ checkpoint: f.checkpoint });
  assert.equal(publicReceipt.visibilityAtReadback, "published");
  assert.equal(publicReceipt.githubImmutableAtReadback, true);
  assert.equal(f.staged.visibilityAtReadback, "draft");
  assert.equal(f.staged.githubImmutableAtReadback, false);
  assert.equal(publicReceipt.releaseId, f.staged.releaseId);
  assert.deepEqual(publicReceipt.assets, f.staged.assets);
  assert.equal(mutations(f.state).length, 1);
  assert.equal(mutations(f.state)[0].method, "PATCH");
  assert.equal(f.state.releases.length, 1);
  const after = await f.store().readBundle({ receipt: f.staged });
  assert.deepEqual(after.manifest, before.manifest);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual((await f.store().readBundle({ receipt: publicReceipt })).files, before.files);
  const rerun = await f.store().publishAcceptedBundle({ checkpoint: f.checkpoint });
  assert.deepEqual(rerun, publicReceipt);
  assert.equal(mutations(f.state).length, 1);
});

test("local accepted tracking ref cannot authorize publication when actual remote main excludes the commit", async (t) => {
  const f = await acceptedFixture(t);
  f.state.mainCommit = f.codeCommit;
  await assert.rejects(f.store().publishAcceptedBundle({ checkpoint: f.checkpoint }), { code: "NOT_ACCEPTED" });
  assert.equal(mutations(f.state).length, 0);
  assert.equal(f.state.releases[0].draft, true);
  f.state.mainCommit = "d".repeat(40);
  f.state.remoteAncestry.add(`${f.acceptedCommit}...${f.state.mainCommit}`);
  f.state.onRequest = ({ url }) => url.pathname.includes("/compare/") ? json({ base_commit: { sha: f.acceptedCommit }, merge_base_commit: { sha: f.codeCommit }, status: "ahead", behind_by: 0, ahead_by: 1 }) : undefined;
  await assert.rejects(f.store().publishAcceptedBundle({ checkpoint: f.checkpoint }), { code: "NOT_ACCEPTED" });
  assert.equal(mutations(f.state).length, 0);
});

test("publication recovery accepts a proven accepted ancestor and never creates another release", async (t) => {
  const f = await acceptedFixture(t);
  f.state.mainCommit = "e".repeat(40);
  f.state.remoteAncestry.add(`${f.acceptedCommit}...${f.state.mainCommit}`);
  const recovered = await f.store().publishAcceptedBundle({ checkpoint: f.checkpoint });
  assert.equal(recovered.visibilityAtReadback, "published");
  assert.equal(f.state.releases.length, 1);
  assert.equal(mutations(f.state).length, 1);
  const comparisons = f.state.calls.filter(({ url }) => url.pathname.includes("/compare/"));
  assert.ok(comparisons.length >= 2);
  for (const { url } of comparisons) { assert.equal(url.searchParams.get("page"), "2"); assert.equal(url.searchParams.get("per_page"), "1"); }
});

test("missing or replaced accepted draft assets never cause new uploads during publication", async (t) => {
  const f = await acceptedFixture(t);
  f.state.assets.delete(f.staged.assets["kg.json"].id);
  await assert.rejects(f.store().publishAcceptedBundle({ checkpoint: f.checkpoint }), { code: "IMMUTABLE_CONFLICT" });
  assert.equal(mutations(f.state).length, 0);
  assert.equal(f.state.releases[0].draft, true);
});

test("post-acceptance publish uncertainty reconciles without a second PATCH or candidate version", async (t) => {
  const f = await acceptedFixture(t);
  const durable = new Set();
  const fetchImpl = async (url, options) => {
    const response = await f.fetchImpl(url, options);
    if (options.method === "PATCH") throw new Error("lost successful publication response");
    return response;
  };
  const receipt = await f.store({ fetchImpl, onMutationIntent: ({ operation }) => durable.add(operation), onMutationReconciled: ({ operation }) => durable.delete(operation) }).publishAcceptedBundle({ checkpoint: f.checkpoint });
  assert.equal(receipt.visibilityAtReadback, "published");
  assert.equal(durable.size, 0);
  assert.equal(mutations(f.state).length, 1);
  assert.equal(f.state.releases.length, 1);
});

test("process restart with unknown publication intent fails closed until read-only success is observed", async (t) => {
  const f = await acceptedFixture(t);
  const operation = `${f.tag}:publish`;
  const store = f.store({ pendingOperations: [operation] });
  await assert.rejects(store.publishAcceptedBundle({ checkpoint: f.checkpoint }), { code: "UNCERTAIN_MUTATION" });
  assert.equal(mutations(f.state).length, 0);
  // Simulate completion of the old in-flight request, not a new adapter write.
  f.state.releases[0].draft = false; f.state.releases[0].immutable = true;
  f.state.tagObject = { type: "commit", sha: f.codeCommit };
  const resumed = await store.publishAcceptedBundle({ checkpoint: f.checkpoint });
  assert.equal(resumed.visibilityAtReadback, "published");
  assert.equal(mutations(f.state).length, 0);
});

test("staging retries remain drafts and a staged receipt cannot authorize publication", async (t) => {
  const f = await fixture(t); const gh = fakeGitHub();
  const staged = await gh.store().stageBundle(optionsFor(f));
  gh.state.calls.length = 0;
  assert.deepEqual(await gh.store().stageBundle(optionsFor(f)), staged);
  assert.equal(mutations(gh.state).length, 0);
  assert.equal(gh.state.tagObject, null);
  assert.deepEqual((await gh.store().readBundle({ receipt: staged })).manifest, f.manifest);
  await assert.rejects(gh.store().publishAcceptedBundle({ checkpoint: staged }), /not a capability/u);
  assert.equal(mutations(gh.state).length, 0);
});

test("publication rechecks remote acceptance after the durable intent hook", async (t) => {
  const f = await acceptedFixture(t);
  const store = f.store({ onMutationIntent: ({ action }) => { assert.equal(action, "publish"); f.state.mainCommit = f.codeCommit; } });
  await assert.rejects(store.publishAcceptedBundle({ checkpoint: f.checkpoint }), { code: "UNCERTAIN_MUTATION" });
  assert.equal(mutations(f.state).length, 0);
  assert.equal(f.state.releases[0].draft, true);
});

test("publication checks exact staged assets again after the durable intent hook", async (t) => {
  const f = await acceptedFixture(t);
  const store = f.store({ onMutationIntent: () => { f.state.assets.delete(f.staged.assets["kg.json"].id); } });
  await assert.rejects(store.publishAcceptedBundle({ checkpoint: f.checkpoint }), { code: "UNCERTAIN_MUTATION" });
  assert.equal(mutations(f.state).length, 0);
  assert.equal(f.state.releases[0].draft, true);
});

test("published or immutable observations cannot silently downgrade to draft or mutable", async (t) => {
  const f = await acceptedFixture(t);
  const receipt = await f.store().publishAcceptedBundle({ checkpoint: f.checkpoint });
  f.state.releases[0].immutable = false;
  await assert.rejects(f.store().readBundle({ receipt }), { code: "IMMUTABLE_CONFLICT" });
  f.state.releases[0].immutable = true; f.state.releases[0].draft = true;
  await assert.rejects(f.store().readBundle({ receipt }), { code: "IMMUTABLE_CONFLICT" });
});

async function recoveryFixture(t, artifacts) {
  const f = await fixture(t, artifacts); const durable = new Set();
  const gh = fakeGitHub({ onRequest: ({ url, method }) => url.origin === "https://uploads.github.com" && method === "POST" ? json({}, 401) : undefined });
  await assert.rejects(gh.store({ onMutationIntent: ({ operation }) => durable.add(operation), onMutationReconciled: ({ operation }) => durable.delete(operation) }).stageBundle(optionsFor(f)), { code: "UNCERTAIN_MUTATION" });
  gh.state.onRequest = undefined;
  gh.state.mainCommit = "b".repeat(40); gh.state.proposalCommit = targetCommit;
  const bundle = await prepareAuditBundle(f.dir); const binding = bundle.files["manifest.json"];
  const operation = [...durable][0]; const release = gh.state.releases[0];
  const original = join(f.root, "original.json");
  const originalBytes = `${canonicalJson({ schemaVersion: 1, repository, pendingOperations: [operation], candidate: { bundleId: bundle.bundleId, targetCommit } })}\n`;
  await writeFile(original, originalBytes);
  const approval = { schemaVersion: 1, kind: "same-target-upload-convergence", operation, action: "upload", repository,
    expectedMain: "b".repeat(40), proposalRef: "refs/heads/review/fixture", recoveryCodeCommit: "c".repeat(40),
    originalJournalPath: original, recoveryDirectory: join(f.root, "recovery"),
    tag: f.tag, bundleId: bundle.bundleId, targetCommit, manifestSha256: bundle.manifestSha256, releaseId: release.id,
    asset: { name: binding.assetName, bytes: binding.bytes, sha256: binding.sha256 }, originalJournalSha256: sha256(originalBytes),
    reviewedAt: "2026-10-09T10:00:00.000Z", reason: "Fixture-only explicit recovery review" };
  const reservationOptions = { directory: join(f.root, "recovery"), originalJournalPath: original };
  const reserveAttempt = createUploadRecoveryReservation(reservationOptions);
  const options = { ...optionsFor(f), approval, reserveAttempt };
  const store = () => gh.store({ pendingOperations: [operation] });
  const insert = async (overrides = {}, bytes) => {
    const content = bytes ?? await readFile(join(f.dir, "manifest.json")); const id = gh.state.nextId++;
    const asset = { id, releaseId: release.id, name: binding.assetName, size: content.length, digest: `sha256:${sha256(content)}`, state: "uploaded", ...overrides };
    gh.state.assets.set(id, asset); gh.state.bytes.set(id, content); return asset;
  };
  return { ...f, gh, binding, operation, approval, options, store, insert, original, originalBytes, reservationOptions };
}

test("explicit upload convergence verifies exact bytes and preserves original journal", async (t) => {
  const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
  const result = await f.store().recoverPendingUpload(f.options);
  assert.equal(result.state, "verified"); assert.equal(result.originalOperationStillPending, true);
  assert.equal(result.asset.sha256, f.binding.sha256);
  assert.equal(mutations(f.gh.state).length, before + 1);
  assert.equal(await readFile(f.original, "utf8"), f.originalBytes);
  const after = mutations(f.gh.state).length;
  assert.equal((await f.store().recoverPendingUpload(f.options)).state, "verified");
  assert.equal(mutations(f.gh.state).length, after); // restart is read-only
});

test("old upload wins before new POST: 422 converges only by downloaded content", async (t) => {
  const f = await recoveryFixture(t); let appeared = false;
  f.gh.state.onRequest = async ({ url, method }) => {
    if (url.origin === "https://uploads.github.com" && method === "POST" && !appeared) {
      appeared = true; await f.insert(); return json({}, 422);
    }
  };
  const before = mutations(f.gh.state).length;
  const result = await f.store().recoverPendingUpload(f.options);
  assert.equal(result.state, "verified"); assert.equal(f.gh.state.assets.size, 1);
  assert.equal(mutations(f.gh.state).length, before + 1);
});

test("new upload wins before late old delivery: server rejects duplicate name", async (t) => {
  const f = await recoveryFixture(t); let delivered = false; let oldStatus;
  f.gh.state.onRequest = async ({ url, method }, state) => {
    if (method === "GET" && /\/releases\/\d+\/assets$/u.test(url.pathname) && state.assets.size && !delivered) {
      delivered = true;
      const response = await f.gh.fetchImpl(`https://uploads.github.com${base}/releases/${f.approval.releaseId}/assets?name=${f.binding.assetName}`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: await readFile(join(f.dir, "manifest.json")), redirect: "manual" });
      oldStatus = response.status;
    }
  };
  assert.equal((await f.store().recoverPendingUpload(f.options)).state, "verified");
  assert.equal(oldStatus, 422); assert.equal(f.gh.state.assets.size, 1);
});

test("asset appearing at reservation boundary is verified without a new POST", async (t) => {
  const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
  const reserveAttempt = async (approval) => { const reservation = await f.options.reserveAttempt(approval); await f.insert(); return reservation; };
  assert.equal((await f.store().recoverPendingUpload({ ...f.options, reserveAttempt })).state, "verified");
  assert.equal(mutations(f.gh.state).length, before);
});

test("starter, wrong content and duplicate assets block convergence without mutation", async (t) => {
  for (const mode of ["starter", "wrong-content", "duplicate"]) {
    const f = await recoveryFixture(t);
    if (mode === "starter") await f.insert({ state: "starter" });
    if (mode === "wrong-content") await f.insert({ size: f.binding.bytes, digest: `sha256:${f.binding.sha256}` }, Buffer.alloc(f.binding.bytes));
    if (mode === "duplicate") { await f.insert(); await f.insert(); }
    const before = mutations(f.gh.state).length;
    await assert.rejects(f.store().recoverPendingUpload(f.options));
    assert.equal(mutations(f.gh.state).length, before);
    assert.equal(await readFile(f.original, "utf8"), f.originalBytes);
  }
});

test("persistence failure and changed original journal prevent recovery writes", async (t) => {
  const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
  await assert.rejects(f.store().recoverPendingUpload({ ...f.options, reserveAttempt: async () => { throw new Error(token); } }), { code: "JOURNAL_ERROR" });
  await writeFile(f.original, `${f.originalBytes}\n`);
  await assert.rejects(f.store().recoverPendingUpload(f.options), { code: "JOURNAL_ERROR" });
  assert.equal(mutations(f.gh.state).length, before);
});

test("draft changing at durable boundary blocks POST and retains intent", async (t) => {
  const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
  const reserveAttempt = async (approval) => { const reservation = await f.options.reserveAttempt(approval); f.gh.state.releases[0].draft = false; return reservation; };
  await assert.rejects(f.store().recoverPendingUpload({ ...f.options, reserveAttempt }), { code: "UNCERTAIN_MUTATION" });
  assert.equal(mutations(f.gh.state).length, before);
  assert.equal(await readFile(f.original, "utf8"), f.originalBytes);
});

test("timeout, 502, 401 and unverified 422 remain unknown; restart cannot POST again", async (t) => {
  for (const failure of ["timeout", 502, 401, 422]) {
    const f = await recoveryFixture(t);
    f.gh.state.onRequest = async ({ url, method, signal }) => {
      if (url.origin !== "https://uploads.github.com" || method !== "POST") return;
      if (failure === "timeout") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(token)), { once: true }));
      return json({}, failure);
    };
    const before = mutations(f.gh.state).length;
    const store = f.gh.store({ pendingOperations: [f.operation], timeoutMs: 50 });
    await assert.rejects(store.recoverPendingUpload(f.options), { code: "UNCERTAIN_MUTATION" });
    assert.equal(mutations(f.gh.state).length, before + 1);
    f.gh.state.onRequest = undefined;
    await assert.rejects(f.store().recoverPendingUpload({ ...f.options, reserveAttempt: createUploadRecoveryReservation(f.reservationOptions) }), { code: "JOURNAL_ERROR" });
    assert.equal(mutations(f.gh.state).length, before + 1);
    assert.equal(await readFile(f.original, "utf8"), f.originalBytes);
  }
});

test("lost successful response stops; restart only verifies positively observed asset", async (t) => {
  const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
  f.gh.state.onRequest = async ({ url, method }) => {
    if (url.origin === "https://uploads.github.com" && method === "POST") { await f.insert(); throw new Error(token); }
  };
  await assert.rejects(f.store().recoverPendingUpload(f.options), { code: "UNCERTAIN_MUTATION" });
  f.gh.state.onRequest = undefined;
  assert.equal((await f.store().recoverPendingUpload(f.options)).state, "verified");
  assert.equal(mutations(f.gh.state).length, before + 1);
  assert.equal(await readFile(f.original, "utf8"), f.originalBytes);
});

test("different approval binding or extra pending operation cannot use upload recovery", async (t) => {
  const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
  for (const change of [{ targetCommit: "b".repeat(40) }, { releaseId: f.approval.releaseId + 1 }, { asset: { ...f.approval.asset, sha256: "0".repeat(64) } }]) {
    await assert.rejects(f.store().recoverPendingUpload({ ...f.options, approval: { ...f.approval, ...change } }));
  }
  await assert.rejects(f.gh.store({ pendingOperations: [f.operation, `${f.tag}:create`] }).recoverPendingUpload(f.options));
  assert.equal(mutations(f.gh.state).length, before);
});

test("two recovery processes share an exclusive one-attempt reservation", async (t) => {
  const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
  let announce; const started = new Promise((resolve) => { announce = resolve; });
  let finish; const gate = new Promise((resolve) => { finish = resolve; });
  f.gh.state.onRequest = async ({ url, method }) => {
    if (url.origin === "https://uploads.github.com" && method === "POST") { announce(); await gate; }
  };
  const first = f.store().recoverPendingUpload(f.options);
  await started;
  await assert.rejects(f.store().recoverPendingUpload({ ...f.options, reserveAttempt: createUploadRecoveryReservation(f.reservationOptions) }), { code: "JOURNAL_ERROR" });
  finish();
  assert.equal((await first).state, "verified");
  assert.equal(mutations(f.gh.state).length, before + 1);
});

test("main movement, local byte changes and outcome persistence failure stop recovery", async (t) => {
  for (const mode of ["main", "bytes", "outcome"]) {
    const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
    const reserveAttempt = async (approval) => {
      const reservation = await f.options.reserveAttempt(approval);
      if (mode === "main") f.gh.state.mainCommit = "d".repeat(40);
      if (mode === "bytes") await writeFile(join(f.dir, "manifest.json"), Buffer.alloc(f.binding.bytes));
      if (mode === "outcome") return { recordOutcome: async () => { throw new Error("Fixture storage failure"); } };
      return reservation;
    };
    await assert.rejects(f.store().recoverPendingUpload({ ...f.options, reserveAttempt }));
    assert.equal(mutations(f.gh.state).length, before + (mode === "outcome" ? 1 : 0));
    assert.equal(await readFile(f.original, "utf8"), f.originalBytes);
  }
});

test("502 starter is retained and cannot be deleted or retried by recovery", async (t) => {
  const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
  f.gh.state.onRequest = async ({ url, method }) => {
    if (url.origin === "https://uploads.github.com" && method === "POST") { await f.insert({ state: "starter" }); return json({}, 502); }
  };
  await assert.rejects(f.store().recoverPendingUpload(f.options), { code: "UNCERTAIN_MUTATION" });
  f.gh.state.onRequest = undefined;
  await assert.rejects(f.store().recoverPendingUpload(f.options), { code: "IMMUTABLE_CONFLICT" });
  assert.equal(mutations(f.gh.state).length, before + 1);
  assert.equal(f.gh.state.assets.size, 1);
  assert.equal([...f.gh.state.assets.values()][0].state, "starter");
});

test("asset ID substitution during download prevents a verified recovery outcome", async (t) => {
  const f = await recoveryFixture(t); let replaced = false;
  f.gh.state.onRequest = async ({ url, method }, state) => {
    if (method === "GET" && /\/releases\/assets\/\d+$/u.test(url.pathname) && !replaced) {
      replaced = true;
      const old = [...state.assets.values()][0]; state.assets.delete(old.id);
      await f.insert();
    }
  };
  await assert.rejects(f.store().recoverPendingUpload(f.options), { code: "UNCERTAIN_MUTATION" });
  assert.equal(await readFile(f.original, "utf8"), f.originalBytes);
});

test("new recovery directory chain is fsynced through root before any POST", async (t) => {
  const f = await recoveryFixture(t); const events = [];
  const directory = join(f.root, "new-parent", "new-child", "recovery");
  const approval = { ...f.approval, recoveryDirectory: directory };
  const expected = []; let path = directory;
  for (;;) { expected.push(path); const parent = join(path, ".."); if (parent === path) break; path = parent; }
  const reserveAttempt = createUploadRecoveryReservation({ directory, originalJournalPath: f.original, onDurabilityEvent: (event) => events.push(event) });
  f.gh.state.onRequest = ({ url, method }) => {
    if (url.origin === "https://uploads.github.com" && method === "POST") {
      assert.deepEqual(events.filter(({ phase }) => phase === "directory-chain").map(({ path }) => path), expected);
      assert.equal(events.filter(({ phase }) => phase === "file-entry").length, 2);
    }
  };
  assert.equal((await f.store().recoverPendingUpload({ ...f.options, approval, reserveAttempt })).state, "verified");
  assert.equal(events.filter(({ phase }) => phase === "file-entry").length, 3);
});

test("directory sync boundary failures prevent POST; retained file reservation blocks restart", async (t) => {
  for (const failure of ["leaf", "parent", "file-entry"]) {
    const f = await recoveryFixture(t); const before = mutations(f.gh.state).length;
    const directory = f.approval.recoveryDirectory; let seen = 0;
    const reserveAttempt = createUploadRecoveryReservation({ directory, originalJournalPath: f.original, onDurabilityEvent: ({ phase }) => {
      if (phase === "directory-chain") seen++;
      if ((failure === "leaf" && seen === 1) || (failure === "parent" && seen === 2)
        || (failure === "file-entry" && phase === "file-entry")) throw new Error("Simulated sync boundary failure");
    } });
    await assert.rejects(f.store().recoverPendingUpload({ ...f.options, reserveAttempt }), { code: "JOURNAL_ERROR" });
    assert.equal(mutations(f.gh.state).length, before);
    assert.equal(await readFile(f.original, "utf8"), f.originalBytes);
    if (failure === "file-entry") {
      await assert.rejects(f.store().recoverPendingUpload(f.options), { code: "JOURNAL_ERROR" });
      assert.equal(mutations(f.gh.state).length, before);
    }
  }
});

async function actionsProtocolFixture(t) {
  const f = await recoveryFixture(t, { 'kg.json': { entities: [] }, 'lifecycle.json.gz': { transitions: [] },
    'news.json': [], 'diff.json': {}, 'provenance.json.gz': {}, 'source-review.json': null });
  const bundle = await prepareAuditBundle(f.dir);
  const scope = { repository, releaseId: f.approval.releaseId, proposalCommit: targetCommit, bundleId: bundle.bundleId, files: bundle.files, successorOrdinal: 1 };
  const intents = new Set(), outcomes = new Map();
  const fence = { reserve: async (name) => {
    assert.ok(!intents.has(name)); intents.add(name);
    return { recordOutcome: async (outcome) => { assert.ok(!outcomes.has(name)); outcomes.set(name, outcome); } };
  } };
  let checks = 0;
  const run = () => {
    // A fresh transport models a new runner; only the durable fence survives.
    const observed = createObservedUploadTransport({ scope, fetchImpl: f.gh.fetchImpl });
    return runActionsAuditUpload({ scope, priorApproval: f.approval, journal: { pendingOperations: [f.operation] },
      bundleDir: f.dir, fence, checkFrozen: async () => { checks++; }, assertHealthy: observed.assertHealthy,
      createStore: (options) => f.gh.store({ ...options, fetchImpl: observed.fetchImpl }) });
  };
  return { ...f, scope, intents, outcomes, run, checks: () => checks };
}

test('Actions adapter uses real uploader for manifest successor, positive reconciliation and all seven readbacks', async (t) => {
  const f = await actionsProtocolFixture(t); const before = mutations(f.gh.state).length;
  const receipt = await f.run();
  assert.equal(Object.keys(receipt.assets).length, 7);
  assert.equal(receipt.readbackVerified, true);
  assert.equal(mutations(f.gh.state).length - before, 7);
  assert.equal(f.intents.size, 7); assert.equal(f.outcomes.size, 7);
  assert.ok(f.checks() >= 16);
  assert.equal(await readFile(f.original, 'utf8'), f.originalBytes);
});

test('Actions later-asset 401 persists exact outcome and stops before another POST', async (t) => {
  const f = await actionsProtocolFixture(t); let uploads = 0;
  f.gh.state.onRequest = ({ url, method }) => {
    if (url.hostname !== 'uploads.github.com' || method !== 'POST') return;
    uploads++;
    if (uploads === 2) return new Response('{}', { status: 401, headers: { 'x-github-request-id': 'A:B:C:D:E' } });
  };
  await assert.rejects(f.run());
  assert.equal(uploads, 2); assert.equal(f.intents.size, 2); assert.equal(f.outcomes.size, 2);
  const failure = [...f.outcomes.values()].find((v) => v.requestStatus === 401);
  assert.equal(failure.requestMethod, 'POST'); assert.equal(failure.requestHost, 'uploads.github.com');
  assert.equal(failure.githubRequestId, 'A:B:C:D:E'); assert.equal(failure.state, 'unknown');
});

test('Actions 401 remains terminal even if read-only reconciliation subsequently sees correct bytes', async (t) => {
  const f = await actionsProtocolFixture(t); let uploads = 0;
  f.gh.state.onRequest = ({ url, method, body }, state) => {
    if (url.hostname !== 'uploads.github.com' || method !== 'POST') return;
    uploads++;
    if (uploads !== 2) return;
    const id = state.nextId++, bytes = Buffer.from(body);
    state.assets.set(id, { id, releaseId: f.approval.releaseId, name: url.searchParams.get('name'), size: bytes.length, digest: `sha256:${sha256(bytes)}`, state: 'uploaded' });
    state.bytes.set(id, bytes);
    return json({}, 401);
  };
  await assert.rejects(f.run());
  assert.equal(uploads, 2);
  assert.equal([...f.outcomes.values()].filter((v) => v.requestStatus === 401).length, 1);
});

test('every later asset permits 422 only after exact same-name live readback; original journal is unchanged', async (t) => {
  const f = await actionsProtocolFixture(t); let uploads = 0;
  f.gh.state.onRequest = ({ url, method, body }, state) => {
    if (url.hostname !== 'uploads.github.com' || method !== 'POST') return;
    uploads++;
    const id = state.nextId++, bytes = Buffer.from(body);
    state.assets.set(id, { id, releaseId: f.approval.releaseId, name: url.searchParams.get('name'), size: bytes.length, digest: `sha256:${sha256(bytes)}`, state: 'uploaded' });
    state.bytes.set(id, bytes); return json({}, 422);
  };
  const receipt = await f.run();
  assert.equal(receipt.readbackVerified, true); assert.equal(uploads, 7);
  assert.equal(f.intents.size, 7); assert.equal(f.outcomes.size, 7);
  assert.equal(await readFile(f.original, 'utf8'), f.originalBytes);
  await f.run(); assert.equal(uploads, 7); // Existing bytes need no reservation or POST.
  assert.equal(await readFile(f.original, 'utf8'), f.originalBytes);
});

for (const failure of ['422-absent','422-starter','422-wrong-bytes','timeout']) {
  test(`later-asset ${failure} burns its fixed attempt and never continues after restart`, async (t) => {
    const f=await actionsProtocolFixture(t);let uploads=0;
    f.gh.state.onRequest=({url,method,body},state)=>{
      if(url.hostname!=='uploads.github.com'||method!=='POST')return;
      uploads++;if(uploads!==2)return;
      if(failure==='timeout')throw Error('simulated connection timeout');
      if(failure!=='422-absent'){
        const id=state.nextId++,bytes=Buffer.from(body);
        state.assets.set(id,{id,releaseId:f.approval.releaseId,name:url.searchParams.get('name'),size:bytes.length,
          digest:`sha256:${sha256(bytes)}`,state:failure==='422-starter'?'starter':'uploaded'});
        if(failure==='422-wrong-bytes')bytes[0]^=1;
        state.bytes.set(id,bytes);
      }
      return json({},422);
    };
    await assert.rejects(f.run());assert.equal(uploads,2);
    await assert.rejects(f.run());assert.equal(uploads,2);
    assert.equal(await readFile(f.original,'utf8'),f.originalBytes);
    assert.equal(f.intents.size,2);
  });
}
