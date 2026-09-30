import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { createAuthenticatedGitReader } from "./git-object-integrity.mjs";
import { readVerifiedAcceptedCheckpoint } from "./accepted-git.mjs";
import { ACCEPTED_CANDIDATE_VERSION, candidateVerificationBinding, candidateProposalBinding } from "./accepted-candidate.mjs";
import { ALLOWED_ACCEPTED_PATHS, createAcceptedRelease, validateAcceptedReleaseFiles, validateAcceptedReleaseStructure } from "./accepted-release.mjs";

const execFile = promisify(execFileCallback);
const COMMIT = /^[a-f0-9]{40}$/u;
const REF = "refs/heads/main";
const RELEASE_PATH = "data/accepted-release.json";
const SOURCE_PATH = "sources/bedtimenews-archive-contents";
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const preparedRecords = new WeakMap();
const must = (value, message) => { if (!value) throw new Error(`Accepted promotion: ${message}`); };
const hash = (value) => sha256(canonicalJson(value));
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const clone = (value) => JSON.parse(canonicalJson(value));
const bytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const decode = (value) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const binding = (value) => ({ sha256: sha256(value), bytes: value.length });
const reference = (checkpoint) => checkpoint.manifest ? { commit: checkpoint.commit, releaseId: checkpoint.manifest.releaseId, bundleId: checkpoint.manifest.candidateBundleId } : null;
const environment = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extra });
async function git(root, args, extra = {}) {
  try {
    return (await execFile("git", ["--no-replace-objects", "--literal-pathspecs", "-c", "protocol.allow=never", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, ...args], { env: environment(extra), encoding: "buffer", maxBuffer: MAX_TOTAL_BYTES })).stdout;
  } catch {
    // Transport URLs/configuration and their credentials must never leak in errors.
    throw new Error(`Accepted promotion: local Git ${args[0]} failed`);
  }
}
const gitText = async (root, args, extra) => decode(await git(root, args, extra)).trim();
async function assertRoot(root, repository) {
  must(typeof root === "string" && await realpath(root) === root && (await lstat(root)).isDirectory(), "unsafe repository root");
  must(await gitText(root, ["rev-parse", "--show-toplevel"]) === root, "root must be the exact Git worktree root");
  must(typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository), "explicit repository is required");
  const remote = await gitText(root, ["config", "--get", "remote.origin.url"]);
  must([`https://github.com/${repository}`, `https://github.com/${repository}.git`, `git@github.com:${repository}.git`].includes(remote), "origin differs from checkpoint repository");
}
async function recheckCheckpoint(root, capability) {
  const checkpoint = await readVerifiedAcceptedCheckpoint(capability);
  must(checkpoint.allowAncestor === false && checkpoint.mainCommit === checkpoint.commit, "promotion requires the exact main checkpoint, not an ancestor capability");
  // The capability may come from another checkout of the same repository. Its
  // immutable commit is usable, but BOTH checkouts must remain at that base.
  must(await gitText(root, ["rev-parse", "--verify", "refs/remotes/origin/main"]) === checkpoint.commit, "root accepted main differs from checkpoint");
  return checkpoint;
}
function authenticatedReader(root) {
  return createAuthenticatedGitReader(async (oid) => {
    const type = await gitText(root, ["cat-file", "-t", oid]);
    must(["commit", "tree", "blob", "tag"].includes(type), "unexpected Git object type");
    const size = await gitText(root, ["cat-file", "-s", oid]);
    must(/^(0|[1-9]\d*)$/u.test(size) && Number(size) <= MAX_FILE_BYTES, "Git object exceeds byte budget");
    const content = await git(root, ["cat-file", type, oid]);
    must(content.length === Number(size), "incomplete Git object");
    return { type, bytes: content };
  });
}
const commitInfo = (root, commit) => authenticatedReader(root).commit(commit);
const treeEntries = (root, tree) => authenticatedReader(root).entries(tree);
async function readBlob(root, entry, path) {
  must(entry?.type === "blob" && ["100644", "100755"].includes(entry.mode), `missing or nonregular committed file: ${path}`);
  return authenticatedReader(root).blob(entry.oid);
}
function copyFiles(files) {
  must(files instanceof Map || (files && typeof files === "object" && !Array.isArray(files)), "acceptedFiles must be a byte map");
  const result = new Map(); let total = 0;
  for (const [path, value] of files instanceof Map ? files : Object.entries(files)) {
    must(ALLOWED_ACCEPTED_PATHS.includes(path), `unreviewed accepted path: ${String(path)}`);
    must(Buffer.isBuffer(value) || typeof value === "string", "accepted file must contain exact bytes");
    const content = Buffer.from(value);
    total += content.length;
    must(content.length <= MAX_FILE_BYTES && total <= MAX_TOTAL_BYTES, "accepted payload exceeds byte budget");
    result.set(path, content);
  }
  return result;
}
function payloadHash(manifest, files) {
  return hash({ files: { ...Object.fromEntries([...files].map(([path, content]) => [path, binding(content)])), [RELEASE_PATH]: binding(bytes(manifest)) }, source: { path: SOURCE_PATH, commit: manifest.source.commit } });
}
async function assertCodeBindings(root, checkpoint, manifest) {
  const entries = await treeEntries(root, checkpoint.commit);
  for (const [name, config] of Object.entries(manifest.configuration)) {
    const configs = name === "generator" ? Object.entries(config.files) : [[config.path, config.sha256]];
    for (const [path, expected] of configs) must(sha256(await readBlob(root, entries.get(path), path)) === expected, `candidate configuration differs from accepted code commit: ${path}`);
  }
  return entries;
}
function assertPreserved(before, after, targets) {
  const rest = (entries) => Object.fromEntries([...entries].filter(([path]) => !targets.has(path)));
  must(equal(rest(before), rest(after)), "prepared tree changed a non-target path");
}
async function inspectPayload(root, commit, expectedBase) {
  const info = await commitInfo(root, commit);
  must(info.parents.length === 1 && info.parents[0] === expectedBase, "prepared commit must have exactly the expected base parent");
  const entries = await treeEntries(root, info.tree);
  const manifestBytes = await readBlob(root, entries.get(RELEASE_PATH), RELEASE_PATH);
  const manifest = JSON.parse(decode(manifestBytes));
  validateAcceptedReleaseStructure(manifest);
  must(manifestBytes.equals(bytes(manifest)), "prepared receipt must use exact canonical bytes");
  must(manifest.codeCommit === expectedBase, "prepared code commit differs from expected base");
  const files = new Map(); let total = 0;
  for (const path of Object.keys(manifest.acceptedFiles)) {
    const content = await readBlob(root, entries.get(path), path); total += content.length;
    must(total <= MAX_TOTAL_BYTES, "committed accepted payload exceeds byte budget");
    files.set(path, content);
  }
  validateAcceptedReleaseFiles(manifest, files);
  const source = entries.get(SOURCE_PATH);
  must(source?.mode === "160000" && source.type === "commit" && source.oid === manifest.source.commit, "prepared source gitlink differs from manifest");
  assertPreserved(await treeEntries(root, expectedBase), entries, new Set([...files.keys(), RELEASE_PATH, SOURCE_PATH]));
  return { manifest, files, tree: info.tree, payloadHash: payloadHash(manifest, files) };
}
function makePrepared(root, checkpoint, value, noop = false) {
  const descriptor = Object.freeze({ schemaVersion: 1, kind: "prepared-accepted-commit", noop, repository: checkpoint.repository, expectedBase: checkpoint.commit,
    commit: value.commit, tree: value.tree, payloadHash: value.payloadHash, releaseId: value.manifest.releaseId, bundleId: value.manifest.candidateBundleId, sourceCommit: value.manifest.source.commit });
  preparedRecords.set(descriptor, { root, checkpoint: value.checkpoint, manifest: clone(value.manifest), descriptor });
  return descriptor;
}
function preparedRecord(prepared) {
  const record = preparedRecords.get(prepared);
  must(record, "prepared commit must come from preparation or verified recovery; a serialized descriptor is not authority");
  return record;
}

/**
 * Only writes loose Git objects and a disposable index. Never writes caller data,
 * HEAD, branches, remote-tracking refs, the caller index, or source-repository refs.
 * Candidate semantic replay and draft-audit readback are caller prerequisites.
 */
export async function prepareAcceptedCommit({ root, checkpoint: capability, manifest: suppliedManifest, candidateManifest, lifecycle, acceptedFiles, rollbackCheckpoint, noop = false }, hooks = {}) {
  must(Object.keys(hooks).every((name) => ["afterStageFile", "beforeCommit", "beforeReturn"].includes(name) && typeof hooks[name] === "function"), "invalid preparation hooks");
  root = resolve(root);
  const checkpoint = await recheckCheckpoint(root, capability);
  await assertRoot(root, checkpoint.repository);
  must(typeof noop === "boolean", "invalid no-op option");
  const manifest = clone(suppliedManifest); const files = copyFiles(acceptedFiles);
  validateAcceptedReleaseFiles(manifest, files);
  must(equal(manifest.origin, { commit: checkpoint.origin.commit, bindings: checkpoint.origin.bindings }), "release origin differs from trusted checkpoint");
  if (noop) {
    must(checkpoint.manifest && equal(manifest, checkpoint.manifest), "no-op must reuse the exact accepted release");
    must(candidateManifest?.bundleId === manifest.candidateBundleId && hash(candidateManifest) === manifest.candidateManifestHash, "no-op candidate differs from accepted bundle");
    must(files.size === checkpoint.files.size && [...files].every(([path, content]) => content.equals(checkpoint.files.get(path))), "no-op cannot change accepted bytes");
    const { tree } = await commitInfo(root, checkpoint.commit);
    return makePrepared(root, checkpoint, { commit: checkpoint.commit, tree, payloadHash: payloadHash(manifest, files), manifest, checkpoint: capability }, true);
  }
  must(manifest.mode !== "migration", "semantic migration requires a coherent code-and-data review PR, never main CAS");
  must(!candidateManifest?.inputs?.reviewProposal, "proposal-bound candidates require reviewed PR preparation");
  must(manifest.codeCommit === checkpoint.commit, "release code commit differs from expected base");
  const rollback = rollbackCheckpoint ? await readVerifiedAcceptedCheckpoint(rollbackCheckpoint) : null;
  if (rollback) must(rollback.repository === checkpoint.repository && rollback.manifest && rollback.allowAncestor === true && rollback.mainCommit === checkpoint.commit, "rollback target must be an accepted ancestor checkpoint pinned to this exact main");
  const verification = candidateVerificationBinding(checkpoint, { rollbackTarget: rollback });
  must(candidateManifest?.versions?.candidate === ACCEPTED_CANDIDATE_VERSION && equal(candidateManifest.inputs?.verification, verification), "candidate verification differs from trusted checkpoint");
  const reconstructed = createAcceptedRelease({ candidateManifest, lifecycle, acceptedFiles: files,
    origin: { commit: checkpoint.origin.commit, bindings: checkpoint.origin.bindings }, predecessor: reference(checkpoint),
    codeCommit: checkpoint.commit, sourceCommit: manifest.source.commit, auditReceipt: manifest.auditReceipt,
    mode: manifest.mode, transition: manifest.transition, rollbackTarget: rollback ? reference(rollback) : null,
    verifiedPredecessor: checkpoint.manifest ? { commit: checkpoint.commit, manifest: checkpoint.manifest } : null,
    verifiedRollbackTarget: rollback ? { commit: rollback.commit, manifest: rollback.manifest } : null, auditRepository: checkpoint.repository });
  must(equal(manifest, reconstructed), "manifest differs from trusted predecessor/candidate reconstruction");
  const before = await assertCodeBindings(root, checkpoint, manifest);
  const oldSource = before.get(SOURCE_PATH);
  must(!oldSource || oldSource.mode === "160000" && oldSource.type === "commit", "source path must be a gitlink");
  const directory = await mkdtemp(resolve(tmpdir(), "accepted-promotion-"));
  const env = { GIT_INDEX_FILE: resolve(directory, "index"), GIT_AUTHOR_NAME: "bedtimenews-kg", GIT_AUTHOR_EMAIL: "kg-bot@users.noreply.github.com", GIT_COMMITTER_NAME: "bedtimenews-kg", GIT_COMMITTER_EMAIL: "kg-bot@users.noreply.github.com", GIT_AUTHOR_DATE: candidateManifest.inputs.recipe.generatedAt, GIT_COMMITTER_DATE: candidateManifest.inputs.recipe.generatedAt };
  try {
    await git(root, ["read-tree", checkpoint.commit], env);
    const targets = new Map([...files, [RELEASE_PATH, bytes(manifest)]]);
    for (const [path, content] of targets) {
      const old = before.get(path);
      must(!old || old.type === "blob" && ["100644", "100755"].includes(old.mode), `target is not a regular file: ${path}`);
      const file = resolve(directory, "blob"); await writeFile(file, content, { mode: 0o600 });
      const oid = await gitText(root, ["hash-object", "-w", "--no-filters", file], env);
      must(COMMIT.test(oid), "invalid staged blob identity");
      await git(root, ["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`], env);
      await hooks.afterStageFile?.({ path });
    }
    await git(root, ["update-index", "--add", "--cacheinfo", `160000,${manifest.source.commit},${SOURCE_PATH}`], env);
    const tree = await gitText(root, ["write-tree"], env);
    must(COMMIT.test(tree), "invalid prepared tree identity");
    assertPreserved(before, await treeEntries(root, tree), new Set([...targets.keys(), SOURCE_PATH]));
    await hooks.beforeCommit?.();
    await recheckCheckpoint(root, capability);
    const commit = await gitText(root, ["commit-tree", tree, "-p", checkpoint.commit, "-m", `Accept KG release ${manifest.releaseId}`], env);
    const verified = await inspectPayload(root, commit, checkpoint.commit);
    must(verified.tree === tree && verified.payloadHash === payloadHash(manifest, files), "prepared commit payload mismatch");
    await hooks.beforeReturn?.();
    await recheckCheckpoint(root, capability);
    const final = await inspectPayload(root, commit, checkpoint.commit);
    must(final.tree === tree && final.payloadHash === verified.payloadHash, "prepared commit changed at final gate");
    return makePrepared(root, checkpoint, { ...final, commit, checkpoint: capability });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** A proposed semantic change is prepared on an ordinary review branch. It may
 * not change accepted data before generation or use the source-update main CAS.
 * Workflow changes land separately so draft staging needs no new token scopes. */
export async function inspectReviewedMigrationProposal({ root, checkpoint: capability, proposalCommit, proposalRef }) {
  root = resolve(root);
  const checkpoint = await recheckCheckpoint(root, capability);
  await assertRoot(root, checkpoint.repository);
  must(checkpoint.manifest, "semantic migration requires an accepted predecessor");
  must(typeof proposalRef === "string" && proposalRef.startsWith("refs/heads/") && proposalRef !== REF, "migration proposal must target an explicit non-main review branch");
  await git(root, ["check-ref-format", proposalRef]);
  must(COMMIT.test(proposalCommit ?? "") && proposalCommit !== checkpoint.commit, "migration requires a distinct exact proposed code commit");
  must(await gitText(root, ["rev-parse", "--verify", proposalRef]) === proposalCommit && await gitText(root, ["rev-parse", "HEAD"]) === proposalCommit,
    "proposal branch or checkout differs from pinned proposed code");
  must(!(await gitText(root, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"])), "proposal tracked files and index must be clean before audit staging");
  const reader = authenticatedReader(root);
  must(await reader.isAncestor(checkpoint.commit, proposalCommit), "proposal does not descend from the exact accepted main");
  const base = await treeEntries(root, checkpoint.commit), proposed = await treeEntries(root, proposalCommit);
  for (const [path, content] of checkpoint.files) must((await readBlob(root, proposed.get(path), path)).equals(content), `proposal changed accepted output before generation: ${path}`);
  must((await readBlob(root, proposed.get(RELEASE_PATH), RELEASE_PATH)).equals(await readBlob(root, base.get(RELEASE_PATH), RELEASE_PATH)), "proposal changed the accepted receipt before generation");
  must(equal(base.get(SOURCE_PATH), proposed.get(SOURCE_PATH)), "proposal changed the accepted source pointer before generation");
  const restricted = (entries) => Object.fromEntries([...entries].filter(([path]) => path === ".gitmodules" || path.startsWith(".github/workflows/")));
  must(equal(restricted(base), restricted(proposed)), "workflow/source-remote changes must be reviewed separately before semantic migration; no permission expansion");
  return Object.freeze({ repository: checkpoint.repository, expectedMain: checkpoint.commit, proposalCommit, proposalRef });
}

/** Prepare one coherent code+data PR commit without moving ANY branch. The
 * descriptor deliberately is not registered in preparedRecords, and therefore
 * cannot authorize promoteAcceptedCommit or a main ref update. Normal PR review
 * and an explicitly approved merge establish acceptance of this snapshot. */
export async function prepareReviewedMigrationCommit({ root, checkpoint: capability, proposalCommit, proposalRef,
  manifest: suppliedManifest, candidateManifest, lifecycle, acceptedFiles }, hooks = {}) {
  must(Object.keys(hooks).every((name) => ["afterStageFile", "beforeCommit", "beforeReturn"].includes(name) && typeof hooks[name] === "function"), "invalid preparation hooks");
  root = resolve(root);
  const gate = () => inspectReviewedMigrationProposal({ root, checkpoint: capability, proposalCommit, proposalRef });
  const proposal = await gate();
  const checkpoint = await readVerifiedAcceptedCheckpoint(capability);
  const manifest = clone(suppliedManifest), files = copyFiles(acceptedFiles);
  must(manifest.mode === "migration" && manifest.codeCommit === proposalCommit, "PR preparation requires an exact reviewed migration and proposed code ancestor");
  must(equal(candidateManifest.inputs?.reviewProposal, candidateProposalBinding(proposalCommit)), "candidate must bind the exact proposal code commit into its bundle identity");
  must(candidateManifest?.versions?.candidate === ACCEPTED_CANDIDATE_VERSION && equal(candidateManifest.inputs?.verification, candidateVerificationBinding(checkpoint)), "migration verification differs from accepted main checkpoint");
  validateAcceptedReleaseFiles(manifest, files);
  const reconstructed = createAcceptedRelease({ candidateManifest, lifecycle, acceptedFiles: files,
    origin: { commit: checkpoint.origin.commit, bindings: checkpoint.origin.bindings }, predecessor: reference(checkpoint),
    codeCommit: proposalCommit, sourceCommit: manifest.source.commit, auditReceipt: manifest.auditReceipt,
    mode: "migration", transition: manifest.transition, verifiedPredecessor: { commit: checkpoint.commit, manifest: checkpoint.manifest }, auditRepository: checkpoint.repository });
  must(equal(manifest, reconstructed), "migration payload differs from trusted predecessor/candidate reconstruction");
  const before = await assertCodeBindings(root, { commit: proposalCommit }, manifest);
  const directory = await mkdtemp(resolve(tmpdir(), "reviewed-migration-"));
  const env = { GIT_INDEX_FILE: resolve(directory, "index"), GIT_AUTHOR_NAME: "bedtimenews-kg", GIT_AUTHOR_EMAIL: "kg-bot@users.noreply.github.com", GIT_COMMITTER_NAME: "bedtimenews-kg", GIT_COMMITTER_EMAIL: "kg-bot@users.noreply.github.com", GIT_AUTHOR_DATE: candidateManifest.inputs.recipe.generatedAt, GIT_COMMITTER_DATE: candidateManifest.inputs.recipe.generatedAt };
  try {
    await git(root, ["read-tree", proposalCommit], env);
    const targets = new Map([...files, [RELEASE_PATH, bytes(manifest)]]);
    for (const [path, content] of targets) {
      const old = before.get(path);
      must(!old || old.type === "blob" && ["100644", "100755"].includes(old.mode), `target is not a regular file: ${path}`);
      const file = resolve(directory, "blob"); await writeFile(file, content, { mode: 0o600 });
      const oid = await gitText(root, ["hash-object", "-w", "--no-filters", file], env);
      must(COMMIT.test(oid), "invalid migration blob identity");
      await git(root, ["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`], env);
      await hooks.afterStageFile?.({ path });
    }
    await git(root, ["update-index", "--add", "--cacheinfo", `160000,${manifest.source.commit},${SOURCE_PATH}`], env);
    const tree = await gitText(root, ["write-tree"], env);
    assertPreserved(before, await treeEntries(root, tree), new Set([...targets.keys(), SOURCE_PATH]));
    await hooks.beforeCommit?.(); await gate();
    const commit = await gitText(root, ["commit-tree", tree, "-p", proposalCommit, "-m", `Review KG semantic migration ${manifest.releaseId}`], env);
    const verified = await inspectPayload(root, commit, proposalCommit);
    must(verified.tree === tree && verified.payloadHash === payloadHash(manifest, files), "prepared migration payload mismatch");
    await hooks.beforeReturn?.(); await gate();
    const final = await inspectPayload(root, commit, proposalCommit);
    must(final.tree === tree && final.payloadHash === verified.payloadHash, "migration payload changed at final gate");
    return Object.freeze({ schemaVersion: 1, kind: "prepared-reviewed-migration-pr", ...proposal,
      commit, tree, payloadHash: verified.payloadHash, releaseId: manifest.releaseId, bundleId: manifest.candidateBundleId,
      sourceCommit: manifest.source.commit, accepted: false, requiresReviewedMerge: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Restore a prepared descriptor from immutable Git after a crash, never from a local receipt.
 * This is read-only recovery. It cannot authorize a push or audit publication by itself.
 * Use a fresh accepted Git checkpoint for public audit publication after remote readback.
 */
export async function recoverPreparedAcceptedCommit({ root, repository, commit, expectedBase, payloadHash: expectedPayloadHash, releaseId }) {
  root = resolve(root); await assertRoot(root, repository);
  const value = await inspectPayload(root, commit, expectedBase);
  must(typeof expectedPayloadHash === "string" && value.payloadHash === expectedPayloadHash && value.manifest.releaseId === releaseId, "recovered payload differs from saved promotion descriptor");
  must(value.manifest.auditReceipt.repository === repository, "recovered audit repository differs");
  return makePrepared(root, { repository, commit: expectedBase }, { ...value, commit });
}
async function assertPrepared(prepared) {
  const record = preparedRecord(prepared);
  await assertRoot(record.root, prepared.repository);
  if (prepared.noop) {
    await recheckCheckpoint(record.root, record.checkpoint);
    return record;
  }
  const actual = await inspectPayload(record.root, prepared.commit, prepared.expectedBase);
  must(actual.tree === prepared.tree && actual.payloadHash === prepared.payloadHash && equal(actual.manifest, record.manifest), "prepared Git payload changed");
  return record;
}
function checkTransport(transport, writable = false) {
  must(transport && typeof transport.readMain === "function" && (!writable || typeof transport.pushFastForward === "function"), "invalid Git transport");
}
async function observe(prepared, transport) {
  try {
    const commit = await transport.readMain({ repository: prepared.repository, ref: REF });
    if (!COMMIT.test(commit ?? "")) return { status: "unresolved", accepted: null, remoteCommit: null, reason: "invalid-remote-main" };
    if (commit === prepared.commit) return { status: prepared.noop ? "noop" : "accepted", accepted: true, remoteCommit: commit, reason: "exact-prepared-commit" };
    if (commit === prepared.expectedBase) return { status: "not-accepted", accepted: false, remoteCommit: commit, reason: "expected-base-unchanged" };
    return { status: "stale", accepted: null, remoteCommit: commit, reason: "remote-main-differs" };
  } catch { return { status: "unresolved", accepted: null, remoteCommit: null, reason: "remote-read-failed" }; }
}
function outcome(prepared, value, pushAttempted) {
  return { ...value, pushAttempted, commit: prepared.commit, expectedBase: prepared.expectedBase, tree: prepared.tree, payloadHash: prepared.payloadHash,
    releaseId: prepared.releaseId, bundleId: prepared.bundleId,
    // Audit publication and Pages are a separate, retryable phase. This function
    // never infers their success from a Git response or recreates a data version.
    publicationPending: value.accepted === true && !prepared.noop };
}

/** Read-only reconciliation. A nonmatching remote head never authorizes a retry. */
export async function reconcileAcceptedCommit({ prepared, transport }) {
  checkTransport(transport); await assertPrepared(prepared);
  return outcome(prepared, await observe(prepared, transport), false);
}

/**
 * At most one exact-base fast-forward request. The transport must enforce both
 * expectedBase and the authenticated single-parent fast-forward invariant at the
 * server. A bounded exact lease is CAS, never authority to rewrite history.
 * A thrown/lost push response is reconciled by a fresh remote read, never retried.
 */
export async function promoteAcceptedCommit({ prepared, transport }) {
  checkTransport(transport, true); const record = await assertPrepared(prepared);
  const before = await observe(prepared, transport);
  if (before.status !== "not-accepted" || prepared.noop) return outcome(prepared, before, false);
  must(record.checkpoint, "recovered descriptors are reconciliation-only; prepare against a fresh checkpoint before pushing");
  await recheckCheckpoint(record.root, record.checkpoint);
  let pushResponse = "returned";
  try { await transport.pushFastForward({ repository: prepared.repository, ref: REF, expectedBase: prepared.expectedBase, commit: prepared.commit, force: false }); }
  catch { pushResponse = "uncertain"; }
  const after = await observe(prepared, transport);
  return { ...outcome(prepared, after, true), pushResponse };
}
