import { execFile as execFileCallback } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { createAuthenticatedGitReader } from "./git-object-integrity.mjs";
import { ALLOWED_ACCEPTED_PATHS, REQUIRED_ACCEPTED_PATHS, validateAcceptedReleaseFiles, validateAcceptedReleaseStructure } from "./accepted-release.mjs";

const execFile = promisify(execFileCallback);
const COMMIT = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REF = "refs/remotes/origin/main";
const RELEASE_PATH = "data/accepted-release.json";
const ORIGIN_PATHS = Object.freeze({ acceptedState: "data/archive-state.json", acceptedKG: "data/generated/kg.json", acceptedNews: "data/processed/news.json" });
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const capabilities = new WeakMap();
const must = (value, message) => { if (!value) throw new Error(`Accepted Git checkpoint: ${message}`); };
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const clone = (value) => JSON.parse(canonicalJson(value));
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
async function git(root, args, { allowFailure = false } = {}) {
  try {
    const result = await execFile("git", ["--no-replace-objects", "--literal-pathspecs", "-c", "protocol.allow=never", "-C", root, ...args], { env: environment(), encoding: "buffer", maxBuffer: MAX_FILE_BYTES + 1024 });
    return { bytes: result.stdout, code: 0 };
  } catch (error) {
    if (allowFailure && Number.isInteger(error.code)) return { bytes: Buffer.alloc(0), code: error.code };
    // Never propagate raw Git stderr/configuration, which can contain private remote credentials.
    throw new Error(`Accepted Git checkpoint: local Git ${args[0]} failed`);
  }
}
const gitText = async (root, args) => decode((await git(root, args)).bytes).trim();

async function assertRoot(root, repository) {
  must(typeof repository === "string" && REPOSITORY.test(repository), "explicit owner/repo is required");
  must(await realpath(root) === root && (await lstat(root)).isDirectory(), "repository root or ancestor is unsafe");
  must(await gitText(root, ["rev-parse", "--show-toplevel"]) === root, "root must be the exact Git worktree root");
  const remote = await gitText(root, ["config", "--get", "remote.origin.url"]);
  must([`https://github.com/${repository}`, `https://github.com/${repository}.git`, `git@github.com:${repository}.git`].includes(remote), "origin does not identify the explicit GitHub repository");
}
function objectReader(root) {
  return createAuthenticatedGitReader(async (oid) => {
    const type = await gitText(root, ["cat-file", "-t", oid]);
    must(["commit", "tree", "blob", "tag"].includes(type), "unexpected Git object type");
    const size = await gitText(root, ["cat-file", "-s", oid]);
    must(/^(?:0|[1-9]\d*)$/u.test(size) && Number.isSafeInteger(Number(size)) && Number(size) <= MAX_FILE_BYTES, "checkpoint object exceeds byte budget");
    const bytes = (await git(root, ["cat-file", type, oid])).bytes;
    must(bytes.length === Number(size), "incomplete checkpoint object");
    return { type, bytes };
  });
}
async function assertCommit(root, commit, reader) {
  must(typeof commit === "string" && COMMIT.test(commit), "an exact 40-hex commit is required");
  must((await reader.object(commit)).type === "commit", "pinned object is not a commit");
  await reader.commit(commit);
}
async function ancestor(root, older, newer, reader) {
  must(await reader.isAncestor(older, newer), "checkpoint history is not an ancestor of accepted main");
}
async function entryAt(root, commit, path, reader) {
  must(ALLOWED_ACCEPTED_PATHS.includes(path) || path === RELEASE_PATH || path === "sources/bedtimenews-archive-contents", "unreviewed checkpoint path");
  return reader.entry(commit, path);
}
async function readFileAt(root, commit, path, { optional = false, reader } = {}) {
  const entry = await entryAt(root, commit, path, reader);
  if (!entry && optional) return null;
  must(entry && entry.type === "blob" && ["100644", "100755"].includes(entry.mode), "checkpoint file missing or not regular");
  return reader.blob(entry.oid);
}

async function readOrigin(root, commit, expectedBindings, reader) {
  await assertCommit(root, commit, reader);
  const bytes = {}; const bindings = {};
  for (const [name, path] of Object.entries(ORIGIN_PATHS)) {
    bytes[name] = await readFileAt(root, commit, path, { reader });
    bindings[name] = { path, sha256: sha256(bytes[name]) };
  }
  if (expectedBindings) must(equal(bindings, expectedBindings), "frozen origin bytes no longer match accepted receipt");
  return { commit, bindings, bytes };
}
async function inspect(root, repository, commit, allowAncestor) {
  await assertRoot(root, repository); const reader = objectReader(root); await assertCommit(root, commit, reader);
  const mainCommit = await gitText(root, ["rev-parse", "--verify", REF]);
  must(COMMIT.test(mainCommit), "accepted main ref is unavailable");
  if (allowAncestor) await ancestor(root, commit, mainCommit, reader);
  else must(commit === mainCommit, "checkpoint is not the exact pinned accepted main commit");
  const receiptBytes = await readFileAt(root, commit, RELEASE_PATH, { optional: true, reader });
  let manifest = null; let origin; const files = new Map();
  if (receiptBytes) {
    manifest = JSON.parse(decode(receiptBytes));
    validateAcceptedReleaseStructure(manifest);
    must(manifest.auditReceipt.repository === repository, "audit store differs from the accepted repository");
    for (const path of Object.keys(manifest.acceptedFiles)) files.set(path, await readFileAt(root, commit, path, { reader }));
    validateAcceptedReleaseFiles(manifest, files);
    await ancestor(root, manifest.origin.commit, commit, reader);
    await ancestor(root, manifest.codeCommit, commit, reader);
    if (manifest.predecessor) await ancestor(root, manifest.predecessor.commit, commit, reader);
    if (manifest.rollbackTarget) await ancestor(root, manifest.rollbackTarget.commit, commit, reader);
    const gitlink = await entryAt(root, commit, manifest.source.repository.submodulePath, reader);
    must(gitlink?.type === "commit" && gitlink.mode === "160000" && gitlink.oid === manifest.source.commit, "accepted source gitlink differs from release");
    origin = await readOrigin(root, manifest.origin.commit, manifest.origin.bindings, reader);
  } else {
    must(!allowAncestor, "legacy ancestors are not accepted rollback checkpoints");
    for (const path of ALLOWED_ACCEPTED_PATHS) {
      const bytes = await readFileAt(root, commit, path, { optional: !REQUIRED_ACCEPTED_PATHS.includes(path), reader });
      if (bytes) files.set(path, bytes);
    }
    const state = JSON.parse(decode(files.get(ORIGIN_PATHS.acceptedState)));
    must(state.schemaVersion === 3, "bootstrap requires legacy accepted state, not an unbound release state");
    origin = await readOrigin(root, commit, undefined, reader);
  }
  must([...files.values(), ...Object.values(origin.bytes)].reduce((sum, bytes) => sum + bytes.length, 0) <= MAX_TOTAL_BYTES, "accepted/origin outputs exceed byte budget");
  return { root, repository, commit, allowAncestor, mainCommit, manifest, receiptBytes, files, origin };
}

/** Load immutable Git data, never the editable working-tree receipt. No network requests. */
export async function loadAcceptedGitCheckpoint({ root, repository, commit, allowAncestor = false }) {
  must(typeof root === "string" && typeof allowAncestor === "boolean", "invalid checkpoint request");
  const snapshot = await inspect(resolve(root), repository, commit, allowAncestor);
  const capability = Object.freeze({ repository, commit });
  capabilities.set(capability, snapshot);
  return capability;
}
function internal(capability) {
  const value = capabilities.get(capability);
  must(value, "a checkpoint must be loaded from trusted Git; a local receipt/boolean is not a capability");
  return value;
}

/** Recheck the pinned LOCAL main ref. Promotion must separately reconcile the actual remote ref. */
export async function assertAcceptedGitCheckpointUnchanged(capability) {
  const previous = internal(capability);
  const current = await inspect(previous.root, previous.repository, previous.commit, previous.allowAncestor);
  must(current.mainCommit === previous.mainCommit, "accepted main ref changed during operation");
  must(equal(current.manifest, previous.manifest) && equal(current.origin.bindings, previous.origin.bindings), "accepted receipt or origin changed during operation");
  must((current.receiptBytes === null && previous.receiptBytes === null) || current.receiptBytes?.equals(previous.receiptBytes), "accepted receipt bytes changed during operation");
  must(current.files.size === previous.files.size && [...current.files].every(([path, bytes]) => bytes.equals(previous.files.get(path))), "accepted Git output bytes changed during operation");
}

/** Fresh copies prevent caller mutation from changing the loader's trust record. */
export async function readVerifiedAcceptedCheckpoint(capability) {
  await assertAcceptedGitCheckpointUnchanged(capability);
  const value = internal(capability);
  return {
    commit: value.commit, mainCommit: value.mainCommit, allowAncestor: value.allowAncestor,
    repository: value.repository, manifest: value.manifest === null ? null : clone(value.manifest),
    files: new Map([...value.files].map(([path, bytes]) => [path, Buffer.from(bytes)])),
    origin: { commit: value.origin.commit, bindings: clone(value.origin.bindings), bytes: Object.fromEntries(Object.entries(value.origin.bytes).map(([name, bytes]) => [name, Buffer.from(bytes)])) },
  };
}
