import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { readVerifiedAcceptedCheckpoint } from "./accepted-git.mjs";

// GitHub REST contracts checked against the official 2026-03-10 documentation:
// https://docs.github.com/en/rest/releases/releases
// https://docs.github.com/en/rest/releases/assets
// No network, environment reads, or filesystem I/O occurs on import.
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const FILES = new Set(["diff.json", "kg.json", "lifecycle.json.gz", "news.json", "provenance.json.gz", "source-review.json"]);
const DOWNLOAD_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);
export const AUDIT_STORE_LIMITS = Object.freeze({
  manifestBytes: 1024 * 1024,
  fileBytes: 128 * 1024 * 1024,
  totalBytes: 129 * 1024 * 1024,
  metadataBytes: 4 * 1024 * 1024,
  pages: 100,
});
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export class AuditStoreError extends Error {
  constructor(code, message, details = {}) {
    super(`Audit store: ${message}`);
    this.name = "AuditStoreError";
    this.code = code;
    Object.assign(this, details);
  }
}
const must = (condition, message, code = "INVALID_AUDIT") => {
  if (!condition) throw new AuditStoreError(code, message);
};
function limitsFor(overrides = {}) {
  must(isObject(overrides) && Object.keys(overrides).every((key) => Object.hasOwn(AUDIT_STORE_LIMITS, key)), "invalid limits");
  const limits = { ...AUDIT_STORE_LIMITS, ...overrides };
  // Overrides may tighten the ceilings, never turn a bounded read into an unbounded one.
  for (const [key, value] of Object.entries(limits)) must(Number.isSafeInteger(value) && value > 0 && value <= AUDIT_STORE_LIMITS[key], `invalid ${key} limit`);
  return limits;
}
function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child !== null && typeof child === "object") freeze(child);
  return value;
}

async function readBoundedFile(directory, name, limit) {
  must(await realpath(directory) === directory, "bundle directory or ancestor is a symlink");
  const path = join(directory, name);
  const before = await lstat(path);
  must(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, "bundle assets must be regular, unlinked files");
  must(before.size <= limit, "local file exceeds byte limit", "BYTE_LIMIT");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    must(opened.isFile() && opened.nlink === 1 && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, "local file changed while opening");
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      must(bytesRead > 0, "local file was truncated while reading");
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await lstat(path);
    must(!extra.bytesRead && after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size && after.mtimeMs === opened.mtimeMs && await realpath(directory) === directory, "local file changed while reading");
    return buffer;
  } finally { await handle.close(); }
}

function describeAuditManifest(manifestBytes, limits) {
  must(manifestBytes.length <= limits.manifestBytes, "manifest exceeds byte limit", "BYTE_LIMIT");
  let manifest;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); }
  catch { throw new AuditStoreError("INVALID_AUDIT", "invalid manifest JSON"); }
  must(isObject(manifest) && Object.keys(manifest).sort().join(",") === "artifacts,bundleId,inputs,kind,schemaVersion,versions" && manifest.schemaVersion === 1 && manifest.kind === "offline-candidate" && HASH.test(manifest.bundleId ?? ""), "invalid candidate manifest");
  must(isObject(manifest.inputs) && Object.keys(manifest.inputs).length && Object.values(manifest.inputs).every((binding) => isObject(binding) && HASH.test(binding.sha256 ?? "")), "invalid input bindings");
  must(isObject(manifest.versions) && Object.keys(manifest.versions).length && Object.values(manifest.versions).every((version) => typeof version === "string" && version.trim()), "invalid version bindings");
  must(isObject(manifest.artifacts) && Object.keys(manifest.artifacts).length, "missing artifact bindings");
  must(manifestBytes.equals(Buffer.from(`${canonicalJson(manifest)}\n`)), "manifest must be canonical JSON");
  const { bundleId, ...identity } = manifest;
  must(sha256(canonicalJson(identity)) === bundleId, "bundleId does not bind manifest contents");
  const names = Object.keys(manifest.artifacts).sort();
  must(names.every((name) => FILES.has(name)), "unsupported artifact; source archives are not permitted");
  let totalBytes = manifestBytes.length;
  const files = { "manifest.json": { sha256: sha256(manifestBytes), bytes: manifestBytes.length } };
  for (const name of names) {
    const binding = manifest.artifacts[name];
    must(isObject(binding) && Object.keys(binding).sort().join(",") === "bytes,sha256" && HASH.test(binding.sha256 ?? "") && Number.isSafeInteger(binding.bytes) && binding.bytes >= 0, "invalid artifact binding");
    must(binding.bytes <= limits.fileBytes, "artifact exceeds byte limit", "BYTE_LIMIT");
    totalBytes += binding.bytes;
    must(totalBytes <= limits.totalBytes, "bundle exceeds total byte limit", "BYTE_LIMIT");
    files[name] = { ...binding };
  }
  for (const [name, binding] of Object.entries(files)) binding.assetName = `${binding.sha256}-${name}`;
  return { bundleId, manifest, manifestSha256: sha256(manifestBytes), files, totalBytes };
}

/** Hash/size verification only. The caller must separately validate/replay the candidate's semantics. */
export async function prepareAuditBundle(bundleDir, { limits: overrides } = {}) {
  const limits = limitsFor(overrides);
  must(typeof bundleDir === "string" && bundleDir.trim(), "bundleDir is required");
  const directory = resolve(bundleDir);
  const stat = await lstat(directory);
  must(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(directory) === directory, "bundle directory must be canonical and real");
  const manifestBytes = await readBoundedFile(directory, "manifest.json", limits.manifestBytes);
  const bundle = describeAuditManifest(manifestBytes, limits);
  must(canonicalJson((await readdir(directory)).sort()) === canonicalJson(Object.keys(bundle.files).sort()), "bundle contains missing or extra files");
  for (const [name, binding] of Object.entries(bundle.manifest.artifacts)) {
    const bytes = await readBoundedFile(directory, name, binding.bytes);
    must(bytes.length === binding.bytes && sha256(bytes) === binding.sha256, "artifact hash/size mismatch");
  }
  return freeze({ bundleDir: directory, ...bundle });
}

/**
 * Caller supplies an explicit GitHub.com repository and token/fetch transport.
 * Call stageBundle only after authorized collaborator-visible storage and semantic validation.
 * Only publishAcceptedBundle may publish, after proving acceptance on remote main.
 * Existing assets are never deleted, edited, or replaced. No settings are changed.
 * Unknown mutation outcomes are reconciled by GET/list; there are no retries.
 * Awaited journal hooks must persist intent before each network mutation and clear
 * it only after verified reconciliation. Restore their operation keys through
 * pendingOperations after a process restart. reconcilePending uses remote reads
 * only and clears only positively confirmed success; absence remains unknown.
 * UNCERTAIN_MUTATION means stop and persist that result before a later invocation.
 * Token permissions are never broadened (Contents:write must already suffice).
 */
export function createGitHubReleaseStore({ owner, repo, token, fetchImpl = globalThis.fetch, timeoutMs = 30_000, limits: overrides,
  pendingOperations = [], onMutationIntent, onMutationReconciled } = {}) {
  must(typeof owner === "string" && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/u.test(owner), "explicit GitHub owner is required");
  must(typeof repo === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,99}$/u.test(repo) && !repo.includes(".."), "explicit GitHub repository name is required");
  must(token === undefined || (typeof token === "string" && token.length > 0 && !/[\r\n]/u.test(token)), "invalid caller token");
  must(typeof fetchImpl === "function", "fetchImpl must be a function");
  must(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, "timeout must be between 1 and 120000 milliseconds");
  const limits = limitsFor(overrides);
  const repository = `${owner}/${repo}`;
  const base = `/repos/${owner}/${repo}`;
  must(Array.isArray(pendingOperations) && pendingOperations.every((operation) => typeof operation === "string" && /^kg-audit-[a-f0-9]{64}:(?:create|publish|upload:[a-f0-9]{64}-[a-zA-Z0-9._-]+)$/u.test(operation)) && new Set(pendingOperations).size === pendingOperations.length, "invalid pending operations");
  must([onMutationIntent, onMutationReconciled].every((hook) => hook === undefined || typeof hook === "function"), "invalid mutation journal hooks");
  const pending = new Set(pendingOperations);
  const active = new Set();
  function operationFor(bundle, targetCommit, action, release, binding) {
    const tag = `kg-audit-${bundle.bundleId}`;
    return freeze({ operation: `${tag}:${action}${binding ? `:${binding.assetName}` : ""}`,
      action, repository, tag, bundleId: bundle.bundleId, targetCommit, manifestSha256: bundle.manifestSha256,
      ...(release ? { releaseId: release.id } : {}),
      ...(binding ? { asset: { name: binding.assetName, bytes: binding.bytes, sha256: binding.sha256 } } : {}) });
  }
  async function journal(hook, operation) {
    try { await hook?.(operation); }
    catch { throw new AuditStoreError("JOURNAL_ERROR", "mutation journal hook failed; no further mutations are allowed", { operation: operation.operation }); }
  }
  async function confirmed(operation) {
    await journal(onMutationReconciled, operation);
    pending.delete(operation.operation);
  }

  async function request(url, { method = "GET", body, binary = false, maxBytes = limits.metadataBytes, allow404 = false, redirectDownload = false, authenticated = true } = {}) {
    const parsed = new URL(url);
    must(!parsed.username && !parsed.password && parsed.protocol === "https:" && (!authenticated || [API, UPLOADS].includes(parsed.origin)), "unsafe request destination", "UNSAFE_URL");
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AuditStoreError("REQUEST_TIMEOUT", "request timed out")); }, timeoutMs); });
    const run = async () => {
      const headers = { Accept: binary ? "application/octet-stream" : "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
      if (authenticated && token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) {
        headers["Content-Type"] = Buffer.isBuffer(body) ? "application/octet-stream" : "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(body));
      }
      const response = await fetchImpl(url, { method, headers, body, redirect: "manual", signal: controller.signal });
      if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
      if (redirectDownload && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        return { redirect: location };
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new AuditStoreError("HTTP_ERROR", `GitHub request failed with HTTP ${response.status}`, { status: response.status });
      }
      const contentLength = response.headers.get("content-length");
      must(contentLength === null || (/^\d+$/u.test(contentLength) && Number(contentLength) <= maxBytes), "response exceeds byte limit", "BYTE_LIMIT");
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            must(size <= maxBytes, "response exceeds byte limit", "BYTE_LIMIT");
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      const bytes = Buffer.concat(chunks, size);
      if (binary) return bytes;
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new AuditStoreError("INVALID_RESPONSE", "invalid GitHub metadata JSON"); }
    };
    try { return await Promise.race([run(), timeout]); }
    catch (error) {
      controller.abort();
      // Never propagate fetch errors, server bodies, signed URLs, or caller secrets.
      if (error instanceof AuditStoreError) throw error;
      throw new AuditStoreError("REQUEST_FAILED", "GitHub request failed");
    } finally { clearTimeout(timer); }
  }
  const get = (path, options) => request(`${API}${base}${path}`, options);
  async function pages(path) {
    const results = [];
    for (let page = 1; page <= limits.pages; page++) {
      const entries = await get(`${path}?per_page=100&page=${page}`);
      must(Array.isArray(entries) && entries.length <= 100, "invalid paginated response", "INVALID_RESPONSE");
      results.push(...entries);
      if (entries.length < 100) return results;
    }
    throw new AuditStoreError("PAGE_LIMIT", "pagination limit reached; absence cannot be established");
  }
  async function lookup(tag) {
    // The tag endpoint only promises published releases; list also finds drafts.
    const published = await get(`/releases/tags/${tag}`, { allow404: true });
    if (published) return published;
    const matches = (await pages("/releases")).filter((release) => release.tag_name === tag);
    must(matches.length <= 1, "multiple releases claim the same bundle tag", "IMMUTABLE_CONFLICT");
    return matches[0] ?? null;
  }
  async function checkTarget(targetCommit, tag, required = false) {
    const commit = await get(`/git/commits/${targetCommit}`);
    must(commit?.sha === targetCommit, "targetCommit is not an existing repository commit", "IMMUTABLE_CONFLICT");
    const ref = await get(`/git/ref/tags/${tag}`, { allow404: true });
    if (!ref) { must(!required, "published release tag is missing", "IMMUTABLE_CONFLICT"); return; }
    must(ref.ref === `refs/tags/${tag}`, "unexpected Git tag ref", "IMMUTABLE_CONFLICT");
    let object = ref.object;
    const seen = new Set();
    for (let depth = 0; object?.type === "tag" && depth < 8; depth++) {
      must(COMMIT.test(object.sha ?? "") && !seen.has(object.sha), "invalid or cyclic annotated tag", "IMMUTABLE_CONFLICT");
      seen.add(object.sha);
      const annotated = await get(`/git/tags/${object.sha}`);
      must(annotated?.sha === object.sha, "annotated tag identity mismatch", "IMMUTABLE_CONFLICT");
      object = annotated.object;
    }
    must(object?.type === "commit" && object.sha === targetCommit, "existing tag targets a different commit", "IMMUTABLE_CONFLICT");
  }
  function description(bundle, targetCommit) {
    return canonicalJson({ schemaVersion: 1, kind: "kg-audit-bundle", bundleId: bundle.bundleId, manifestSha256: bundle.manifestSha256, targetCommit });
  }
  function validateRelease(release, bundle, targetCommit) {
    must(isObject(release) && Number.isSafeInteger(release.id) && release.id > 0 && release.tag_name === `kg-audit-${bundle.bundleId}` && release.target_commitish === targetCommit && release.name === release.tag_name && release.body === description(bundle, targetCommit) && typeof release.draft === "boolean" && release.prerelease === true && typeof release.immutable === "boolean", "release identity or contents conflict", "IMMUTABLE_CONFLICT");
    const expectedUpload = `${UPLOADS}${base}/releases/${release.id}/assets`;
    must(release.upload_url === `${expectedUpload}{?name,label}` || release.upload_url === expectedUpload, "unsafe upload_url", "UNSAFE_URL");
    return release;
  }
  function validateAsset(asset, binding) {
    must(isObject(asset) && Number.isSafeInteger(asset.id) && asset.id > 0 && asset.name === binding.assetName && asset.state === "uploaded" && asset.size === binding.bytes, "asset name/state/size conflict; never replace existing assets", "IMMUTABLE_CONFLICT");
    must(asset.digest == null || asset.digest === `sha256:${binding.sha256}`, "asset digest conflicts with bound bytes", "IMMUTABLE_CONFLICT");
  }
  async function assetsFor(release, bundle) {
    const assets = await pages(`/releases/${release.id}/assets`);
    const expected = new Set(Object.values(bundle.files).map((binding) => binding.assetName));
    const names = new Set(); const ids = new Set();
    for (const asset of assets) {
      must(expected.has(asset.name) && !names.has(asset.name) && !ids.has(asset.id), "release contains unexpected or duplicate assets", "IMMUTABLE_CONFLICT");
      names.add(asset.name); ids.add(asset.id);
    }
    return new Map(assets.map((asset) => [asset.name, asset]));
  }
  async function download(asset, binding) {
    validateAsset(asset, binding);
    let url = `${API}${base}/releases/assets/${asset.id}`;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const result = await request(url, { binary: true, maxBytes: binding.bytes, redirectDownload: true, authenticated: redirects === 0 });
      if (Buffer.isBuffer(result)) {
        must(result.length === binding.bytes && sha256(result) === binding.sha256, "downloaded asset hash/size mismatch", "READBACK_MISMATCH");
        return result;
      }
      let destination;
      try { destination = new URL(result.redirect); } catch { throw new AuditStoreError("UNSAFE_URL", "invalid download redirect"); }
      must(destination.protocol === "https:" && !destination.username && !destination.password && !destination.port && DOWNLOAD_HOSTS.has(destination.hostname), "unsafe download redirect", "UNSAFE_URL");
      url = destination.href;
    }
    throw new AuditStoreError("UNSAFE_URL", "too many download redirects");
  }
  async function mutate(operation, action, reconcile) {
    const key = operation.operation;
    // The pending marker survives calls on this adapter. Persist uncertain errors
    // in the orchestration checkpoint before constructing a fresh adapter.
    let failure;
    if (!pending.has(key)) {
      await journal(onMutationIntent, operation); // Caller fsync/atomic checkpoint must finish before POST/PATCH.
      pending.add(key);
      try { await action(); } catch (error) {
        // Safe metadata only; never retain a transport error or response body.
        failure = { requestCode: error.code, ...(error.status ? { requestStatus: error.status } : {}) };
      }
    }
    let result;
    try { result = await reconcile(); }
    catch (error) {
      if (error instanceof AuditStoreError && ["IMMUTABLE_CONFLICT", "UNSAFE_URL", "READBACK_MISMATCH"].includes(error.code)) throw error;
      throw new AuditStoreError("UNCERTAIN_MUTATION", "mutation outcome could not be reconciled; do not retry blindly", { operation: key, ...failure });
    }
    if (!result) throw new AuditStoreError("UNCERTAIN_MUTATION", "mutation not confirmed by read-only lookup; do not retry blindly", { operation: key, ...failure });
    await confirmed(operation);
    return result;
  }
  async function verifyRemote(release, bundle, targetCommit, { published = true } = {}) {
    validateRelease(release, bundle, targetCommit);
    must(!published || !release.draft, "release is still a draft", "NOT_PUBLISHED");
    await checkTarget(targetCommit, release.tag_name, published);
    const assets = await assetsFor(release, bundle);
    must(assets.size === Object.keys(bundle.files).length, "release is missing required assets", "IMMUTABLE_CONFLICT");
    const receiptAssets = {};
    for (const [name, binding] of Object.entries(bundle.files)) {
      const asset = assets.get(binding.assetName);
      await download(asset, binding);
      receiptAssets[name] = { id: asset.id, name: asset.name, bytes: binding.bytes, sha256: binding.sha256,
        url: `https://github.com/${repository}/releases/download/${release.tag_name}/${asset.name}` };
    }
    // Recheck membership/IDs after downloads to catch replacements during readback.
    const after = await assetsFor(release, bundle);
    must(after.size === assets.size && [...assets].every(([name, asset]) => after.get(name)?.id === asset.id), "assets changed during readback", "IMMUTABLE_CONFLICT");
    for (const binding of Object.values(bundle.files)) validateAsset(after.get(binding.assetName), binding);
    return { schemaVersion: 2, kind: "github-audit-readback", repository, bundleId: bundle.bundleId,
      manifestSha256: bundle.manifestSha256, targetCommit, tag: release.tag_name, releaseId: release.id,
      releaseUrl: `https://github.com/${repository}/releases/tag/${release.tag_name}`,
      githubImmutableAtReadback: release.immutable, visibilityAtReadback: release.draft ? "draft" : "published", readbackVerified: true, assets: receiptAssets,
      rawSourceArchiveIncluded: false,
      sourceReplay: "Restoring accepted outputs does not guarantee raw upstream re-extraction; upstream Git history must be available separately." };
  }
  async function reconcilePrepared(bundle, targetCommit) {
    const tag = `kg-audit-${bundle.bundleId}`;
    const allowed = new Map([
      ...["create", "publish"].map((action) => { const entry = operationFor(bundle, targetCommit, action); return [entry.operation, entry]; }),
      ...Object.values(bundle.files).map((binding) => { const entry = operationFor(bundle, targetCommit, "upload", undefined, binding); return [entry.operation, entry]; }),
    ]);
    const outstanding = [...pending].filter((operation) => operation.startsWith(`${tag}:`));
    must(outstanding.every((operation) => allowed.has(operation)), "pending operation does not match bundle bindings");
    const outcomes = [];
    for (const operation of outstanding) {
      const entry = allowed.get(operation);
      let success = false; let code;
      try {
        await checkTarget(targetCommit, tag);
        const release = await lookup(tag);
        if (release) {
          validateRelease(release, bundle, targetCommit);
          if (entry.action === "create") success = true;
          if (entry.action === "publish" && !release.draft) {
            await verifyRemote(release, bundle, targetCommit);
            const final = validateRelease(await get(`/releases/${release.id}`), bundle, targetCommit);
            must(final.id === release.id && !final.draft && final.immutable === release.immutable, "release changed during reconciliation", "IMMUTABLE_CONFLICT");
            await checkTarget(targetCommit, tag, true);
            success = true;
          }
          if (entry.action === "upload") {
            const binding = Object.values(bundle.files).find((item) => item.assetName === entry.asset.name);
            const asset = (await assetsFor(release, bundle)).get(binding.assetName);
            if (asset) {
              await download(asset, binding);
              const after = (await assetsFor(release, bundle)).get(binding.assetName);
              validateAsset(after, binding);
              must(after.id === asset.id, "asset changed during reconciliation", "IMMUTABLE_CONFLICT");
              success = true;
            }
          }
        }
      } catch (error) { code = error instanceof AuditStoreError ? error.code : "RECONCILIATION_FAILED"; }
      if (success) await confirmed(entry);
      outcomes.push({ operation, state: success ? "confirmed" : "unknown", ...(code ? { code } : {}) });
    }
    return freeze({ repository, bundleId: bundle.bundleId, outcomes, pendingOperations: [...pending].sort() });
  }
  async function reconcilePending({ bundleDir, targetCommit }) {
    must(COMMIT.test(targetCommit ?? ""), "targetCommit must be an explicit existing full Git commit SHA");
    const bundle = await prepareAuditBundle(bundleDir, { limits });
    const tag = `kg-audit-${bundle.bundleId}`;
    must(!active.has(tag), "bundle operation already in progress", "BUSY");
    active.add(tag);
    try { return await reconcilePrepared(bundle, targetCommit); }
    finally { active.delete(tag); }
  }
  /**
   * Recover exact bytes, without disk writes or semantic trust claims. The caller
   * must authenticate this receipt from a pinned accepted Git checkpoint, never
   * adopt an arbitrary caller-supplied/self-rehashed receipt as acceptance.
   */
  async function readBundle({ receipt }) {
    must(isObject(receipt) && receipt.schemaVersion === 2 && receipt.kind === "github-audit-readback" && receipt.repository === repository && HASH.test(receipt.bundleId ?? "") && HASH.test(receipt.manifestSha256 ?? "") && COMMIT.test(receipt.targetCommit ?? "") && receipt.tag === `kg-audit-${receipt.bundleId}` && Number.isSafeInteger(receipt.releaseId) && receipt.releaseId > 0 && typeof receipt.githubImmutableAtReadback === "boolean" && ["draft", "published"].includes(receipt.visibilityAtReadback) && !(receipt.visibilityAtReadback === "draft" && receipt.githubImmutableAtReadback) && receipt.readbackVerified === true && receipt.rawSourceArchiveIncluded === false, "invalid or wrong-repository audit receipt");
    must(receipt.releaseUrl === `https://github.com/${repository}/releases/tag/${receipt.tag}`, "receipt release URL mismatch");
    must(isObject(receipt.assets) && Object.keys(receipt.assets).length >= 2 && Object.hasOwn(receipt.assets, "manifest.json") && Object.keys(receipt.assets).every((name) => name === "manifest.json" || FILES.has(name)), "invalid receipt asset inventory");
    const files = {}; const ids = new Set(); let total = 0;
    for (const [name, asset] of Object.entries(receipt.assets)) {
      must(isObject(asset) && Number.isSafeInteger(asset.id) && asset.id > 0 && !ids.has(asset.id) && HASH.test(asset.sha256 ?? "") && asset.name === `${asset.sha256}-${name}` && Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && asset.url === `https://github.com/${repository}/releases/download/${receipt.tag}/${asset.name}`, "invalid receipt asset binding");
      must(asset.bytes <= (name === "manifest.json" ? limits.manifestBytes : limits.fileBytes), "receipt asset exceeds byte limit", "BYTE_LIMIT");
      total += asset.bytes;
      must(total <= limits.totalBytes, "receipt bundle exceeds byte limit", "BYTE_LIMIT");
      ids.add(asset.id);
      files[name] = { sha256: asset.sha256, bytes: asset.bytes, assetName: asset.name };
    }
    must(files["manifest.json"].sha256 === receipt.manifestSha256, "receipt manifest hash mismatch");
    // Snapshot all caller bindings before yielding to I/O.
    const expected = freeze({ bundleId: receipt.bundleId, manifestSha256: receipt.manifestSha256,
      targetCommit: receipt.targetCommit, tag: receipt.tag, releaseId: receipt.releaseId,
      githubImmutableAtReadback: receipt.githubImmutableAtReadback, visibilityAtReadback: receipt.visibilityAtReadback, files,
      assets: Object.fromEntries(Object.entries(receipt.assets).map(([name, asset]) => [name, { id: asset.id }])) });
    const release = validateRelease(await get(`/releases/${expected.releaseId}`), expected, expected.targetCommit);
    must(release.id === expected.releaseId && (expected.visibilityAtReadback === "draft" || !release.draft) && (!expected.githubImmutableAtReadback || release.immutable), "receipt release identity or publication state changed", "IMMUTABLE_CONFLICT");
    await checkTarget(expected.targetCommit, expected.tag, !release.draft);
    const assets = await assetsFor(release, expected);
    must(assets.size === Object.keys(expected.files).length, "receipt release is missing assets", "IMMUTABLE_CONFLICT");
    const buffers = new Map();
    // Retrieve/validate the manifest first, before downloading potentially large ledgers.
    const names = ["manifest.json", ...Object.keys(expected.files).filter((name) => name !== "manifest.json").sort()];
    let manifest;
    for (const name of names) {
      const binding = expected.files[name]; const asset = assets.get(binding.assetName);
      must(asset?.id === expected.assets[name].id, "receipt asset ID changed", "IMMUTABLE_CONFLICT");
      const bytes = await download(asset, binding);
      if (name === "manifest.json") {
        const described = describeAuditManifest(bytes, limits);
        must(described.bundleId === expected.bundleId && described.manifestSha256 === expected.manifestSha256 && canonicalJson(described.files) === canonicalJson(expected.files), "downloaded manifest conflicts with receipt bindings", "READBACK_MISMATCH");
        manifest = described.manifest;
      }
      buffers.set(name, bytes);
    }
    const after = await assetsFor(release, expected);
    must(after.size === assets.size, "assets changed during recovery", "IMMUTABLE_CONFLICT");
    for (const [name, binding] of Object.entries(expected.files)) {
      validateAsset(after.get(binding.assetName), binding);
      must(after.get(binding.assetName).id === expected.assets[name].id, "asset ID changed during recovery", "IMMUTABLE_CONFLICT");
    }
    const final = validateRelease(await get(`/releases/${expected.releaseId}`), expected, expected.targetCommit);
    must(final.id === expected.releaseId && (expected.visibilityAtReadback === "draft" || !final.draft) && (!expected.githubImmutableAtReadback || final.immutable) && (!release.immutable || final.immutable) && (release.draft || !final.draft), "release changed during recovery", "IMMUTABLE_CONFLICT");
    await checkTarget(expected.targetCommit, expected.tag, !final.draft);
    return Object.freeze({ manifest: freeze(manifest), files: buffers });
  }
  async function perform({ bundleDir, targetCommit }, stage) {
    must(COMMIT.test(targetCommit ?? ""), "targetCommit must be an explicit existing full Git commit SHA");
    const bundle = await prepareAuditBundle(bundleDir, { limits });
    const tag = `kg-audit-${bundle.bundleId}`;
    must(!active.has(tag), "bundle operation already in progress", "BUSY");
    active.add(tag);
    try {
      const reconciliation = await reconcilePrepared(bundle, targetCommit);
      const unresolved = reconciliation.outcomes.find((outcome) => outcome.state === "unknown");
      if (stage && unresolved) throw new AuditStoreError("UNCERTAIN_MUTATION", "outstanding operation remains unknown; no mutations are allowed", { operation: unresolved.operation });
      await checkTarget(targetCommit, tag);
      let release = await lookup(tag);
      if (!release) {
        must(stage, "audit release does not exist", "NOT_FOUND");
        const body = canonicalJson({ tag_name: tag, target_commitish: targetCommit, name: tag,
          body: description(bundle, targetCommit), draft: true, prerelease: true,
          make_latest: "false", generate_release_notes: false });
        release = await mutate(operationFor(bundle, targetCommit, "create"), () => get("/releases", { method: "POST", body }), async () => {
          const current = await lookup(tag);
          if (current) { validateRelease(current, bundle, targetCommit); await checkTarget(targetCommit, tag, !current.draft); }
          return current;
        });
      }
      validateRelease(release, bundle, targetCommit);
      if (stage && release.draft) {
        must(!release.immutable, "immutable draft cannot be modified", "IMMUTABLE_CONFLICT");
        for (const [name, binding] of Object.entries(bundle.files)) {
          const assets = await assetsFor(release, bundle);
          const existing = assets.get(binding.assetName);
          if (existing) { await download(existing, binding); continue; }
          const current = validateRelease(await get(`/releases/${release.id}`), bundle, targetCommit);
          must(current.id === release.id && current.draft && !current.immutable, "release changed before upload", "IMMUTABLE_CONFLICT");
          const content = await readBoundedFile(bundle.bundleDir, name, binding.bytes);
          must(content.length === binding.bytes && sha256(content) === binding.sha256, "local asset changed before upload");
          const uploadUrl = `${release.upload_url.replace(/\{\?name,label\}$/u, "")}?name=${encodeURIComponent(binding.assetName)}`;
          await mutate(operationFor(bundle, targetCommit, "upload", release, binding), async () => {
            // The durable journal hook is an I/O boundary. Recheck visibility
            // immediately afterward; a stale pre-journal draft is insufficient.
            const latest = validateRelease(await get(`/releases/${release.id}`), bundle, targetCommit);
            must(latest.id === release.id && latest.draft && !latest.immutable, "release changed after upload intent", "IMMUTABLE_CONFLICT");
            await checkTarget(targetCommit, tag);
            const appeared = (await assetsFor(latest, bundle)).get(binding.assetName);
            if (appeared) { await download(appeared, binding); return appeared; }
            const currentBytes = await readBoundedFile(bundle.bundleDir, name, binding.bytes);
            must(currentBytes.length === binding.bytes && sha256(currentBytes) === binding.sha256, "local asset changed after upload intent");
            return request(uploadUrl, { method: "POST", body: currentBytes });
          }, async () => {
            const asset = (await assetsFor(release, bundle)).get(binding.assetName);
            if (asset) await download(asset, binding);
            return asset;
          });
        }

      }
      const receipt = await verifyRemote(release, bundle, targetCommit, { published: !release.draft });
      const final = validateRelease(await get(`/releases/${release.id}`), bundle, targetCommit);
      must(final.id === release.id && final.draft === (receipt.visibilityAtReadback === "draft") && final.immutable === receipt.githubImmutableAtReadback, "release changed during readback", "IMMUTABLE_CONFLICT");
      await checkTarget(targetCommit, tag, !final.draft);
      return freeze(receipt);
    } finally { active.delete(tag); }
  }
  async function assertRemoteAccepted(snapshot) {
    must(snapshot.repository === repository && snapshot.manifest !== null, "publication requires an accepted release from this repository", "NOT_ACCEPTED");
    const main = await get("/git/ref/heads/main");
    must(main?.ref === "refs/heads/main" && main.object?.type === "commit" && COMMIT.test(main.object.sha ?? ""), "remote main commit is unavailable", "NOT_ACCEPTED");
    const mainCommit = main.object.sha;
    if (mainCommit !== snapshot.commit) {
      // Page 2 omits the potentially very large first-page file patches. Only
      // the comparison envelope is needed, not the full commit/diff listing.
      const compare = await get(`/compare/${snapshot.commit}...${mainCommit}?per_page=1&page=2`);
      must(compare?.base_commit?.sha === snapshot.commit && compare.merge_base_commit?.sha === snapshot.commit && compare.status === "ahead" && compare.behind_by === 0 && Number.isSafeInteger(compare.ahead_by) && compare.ahead_by > 0, "checkpoint commit is not an ancestor of actual remote main", "NOT_ACCEPTED");
    }
    const again = await get("/git/ref/heads/main");
    must(again?.ref === "refs/heads/main" && again.object?.type === "commit" && again.object.sha === mainCommit, "remote main changed while proving acceptance", "NOT_ACCEPTED");
  }
  async function publishAcceptedBundle({ checkpoint }) {
    // This imported function validates a module-private WeakMap capability and
    // rereads exact accepted Git bytes. No boolean/receipt can impersonate it.
    const snapshot = await readVerifiedAcceptedCheckpoint(checkpoint);
    must(snapshot.repository === repository && snapshot.manifest?.auditReceipt, "publication requires an accepted Git release", "NOT_ACCEPTED");
    const receipt = snapshot.manifest.auditReceipt;
    const tag = receipt.tag;
    must(!active.has(tag), "bundle operation already in progress", "BUSY");
    active.add(tag);
    try {
      await assertRemoteAccepted(snapshot);
      const recovered = await readBundle({ receipt });
      must(sha256(canonicalJson(recovered.manifest)) === snapshot.manifest.candidateManifestHash && recovered.manifest.bundleId === snapshot.manifest.candidateBundleId, "accepted checkpoint differs from recovered audit bundle", "NOT_ACCEPTED");
      const bundle = describeAuditManifest(recovered.files.get("manifest.json"), limits);
      const targetCommit = receipt.targetCommit;
      const reconciliation = await reconcilePrepared(bundle, targetCommit);
      const unresolved = reconciliation.outcomes.find((outcome) => outcome.state === "unknown");
      if (unresolved) throw new AuditStoreError("UNCERTAIN_MUTATION", "outstanding operation remains unknown; no mutations are allowed", { operation: unresolved.operation });
      let release = validateRelease(await get(`/releases/${receipt.releaseId}`), bundle, targetCommit);
      must(release.id === receipt.releaseId, "accepted release ID changed", "IMMUTABLE_CONFLICT");
      if (release.draft) {
        must(!release.immutable, "immutable draft cannot be published", "IMMUTABLE_CONFLICT");
        release = await mutate(operationFor(bundle, targetCommit, "publish", release), async () => {
          // The durable intent hook may take time. Recheck both trust boundaries
          // after it, immediately before the sole publication PATCH.
          await readVerifiedAcceptedCheckpoint(checkpoint);
          await assertRemoteAccepted(snapshot);
          const current = validateRelease(await get(`/releases/${receipt.releaseId}`), bundle, targetCommit);
          must(current.id === receipt.releaseId && current.draft && !current.immutable, "accepted draft changed before publication", "IMMUTABLE_CONFLICT");
          const currentAssets = await assetsFor(current, bundle);
          must(currentAssets.size === Object.keys(receipt.assets).length, "accepted draft assets changed before publication", "IMMUTABLE_CONFLICT");
          for (const [name, binding] of Object.entries(bundle.files)) {
            const asset = currentAssets.get(binding.assetName);
            validateAsset(asset, binding);
            must(asset.id === receipt.assets[name].id, "accepted draft asset ID changed before publication", "IMMUTABLE_CONFLICT");
          }
          await get(`/releases/${receipt.releaseId}`, { method: "PATCH", body: canonicalJson({ draft: false, make_latest: "false" }) });
        }, async () => {
          const current = validateRelease(await get(`/releases/${receipt.releaseId}`), bundle, targetCommit);
          must(current.id === receipt.releaseId, "release ID changed during publication", "IMMUTABLE_CONFLICT");
          if (current.draft) return null;
          await readBundle({ receipt });
          return current;
        });
      }
      await readVerifiedAcceptedCheckpoint(checkpoint);
      await assertRemoteAccepted(snapshot);
      // The accepted manifest keeps its historical draft readback receipt. Return
      // a fresh observation without rewriting that accepted commit or its ID.
      const observed = await verifyRemote(release, bundle, targetCommit);
      must(Object.entries(receipt.assets).every(([name, asset]) => observed.assets[name]?.id === asset.id), "accepted asset IDs changed", "IMMUTABLE_CONFLICT");
      const final = validateRelease(await get(`/releases/${receipt.releaseId}`), bundle, targetCommit);
      must(final.id === receipt.releaseId && !final.draft && final.immutable === observed.githubImmutableAtReadback, "publication changed during final readback", "IMMUTABLE_CONFLICT");
      await checkTarget(targetCommit, tag, true);
      return freeze(observed);
    } finally { active.delete(tag); }
  }
  return Object.freeze({
    stageBundle: (options) => perform(options, true),
    publishAcceptedBundle,
    verifyBundle: (options) => perform(options, false),
    reconcilePending,
    readBundle,
  });
}
