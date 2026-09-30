import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256, verifyCandidateBundle } from "./candidate-bundle.mjs";
import { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint } from "./accepted-git.mjs";
import { createAuthenticatedGitReader } from "./git-object-integrity.mjs";
import { createAcceptedRelease, validateAcceptedReleaseFiles, validateAcceptedReleaseStructure } from "./accepted-release.mjs";
import { verifyAcceptedCandidate, candidateProposalBinding } from "./accepted-candidate.mjs";
import { candidateRuntimeBinding } from "./candidate-run.mjs";
import { compileOntologyFiles } from "./ontology-compiler.mjs";
import { validate } from "./validate.mjs";
import { validateNewsDataset, validateKnowledgeBaseNewsProjection } from "./news.mjs";

const execFile = promisify(execFileCallback);
const COMMIT = /^[a-f0-9]{40}$/u;
const RECEIPT = "data/accepted-release.json";
const SOURCE = "sources/bedtimenews-archive-contents";
const ARTIFACTS = ["diff.json", "kg.json", "lifecycle.json.gz", "manifest.json", "news.json", "provenance.json.gz", "source-review.json"];
const MAX_FILE = 128 * 1024 * 1024;
const MAX_BUNDLE = 129 * 1024 * 1024;
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const json = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const encoded = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const must = (value, message) => { if (!value) throw new Error(`Migration PR validation: ${message}`); };
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
async function git(root, args) {
  try { return (await execFile("git", ["--no-replace-objects", "--literal-pathspecs", "-c", "protocol.allow=never", "-c", "core.hooksPath=/dev/null", "-C", root, ...args],
    { env: environment(), encoding: "buffer", maxBuffer: MAX_FILE + 1024 })).stdout; }
  catch { throw new Error(`Migration PR validation: local Git ${args[0]} failed`); }
}
const gitText = async (root, args) => (await git(root, args)).toString("utf8").trim();
function readerAt(root) {
  return createAuthenticatedGitReader(async (oid) => {
    const type = await gitText(root, ["cat-file", "-t", oid]);
    const size = await gitText(root, ["cat-file", "-s", oid]);
    must(["commit", "tree", "blob", "tag"].includes(type) && /^(0|[1-9]\d*)$/u.test(size) && Number(size) <= MAX_FILE, "invalid or oversized Git object");
    const bytes = await git(root, ["cat-file", type, oid]);
    must(bytes.length === Number(size), "incomplete Git object");
    return { type, bytes };
  });
}
async function blob(reader, entries, path, optional = false) {
  const entry = entries.get(path);
  if (!entry && optional) return null;
  must(entry?.type === "blob" && ["100644", "100755"].includes(entry.mode), `missing regular committed file: ${path}`);
  return reader.blob(entry.oid);
}
async function workingFile(root, path) {
  const file = resolve(root, path); const stat = await lstat(file);
  must(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_FILE && await realpath(file) === file, `unsafe working file: ${path}`);
  return readFile(file);
}
async function assertWorkingBytes(root, reader, entries, path, expected) {
  must((await blob(reader, entries, path)).equals(expected) && (await workingFile(root, path)).equals(expected), `working/committed bytes differ: ${path}`);
}

/** Receipt-bound rendering checks only; no statement about fresh extraction. */
export async function validateMigrationRendering(root, receipt) {
  const files = new Map();
  if (receipt) {
    validateAcceptedReleaseStructure(receipt);
    for (const path of Object.keys(receipt.acceptedFiles)) files.set(path, await workingFile(root, path));
    validateAcceptedReleaseFiles(receipt, files);
    must(equal(candidateRuntimeBinding(), receipt.runtime), "rendering runtime differs from accepted epoch; reviewed migration required");
    for (const [name, binding] of Object.entries(receipt.configuration)) {
      for (const [path, expected] of name === "generator" ? Object.entries(binding.files) : [[binding.path, binding.sha256]]) {
        must(sha256(await workingFile(root, path)) === expected, `rendering configuration differs: ${path}`);
      }
    }
  } else {
    const state = json(await workingFile(root, "data/archive-state.json"));
    must(state.schemaVersion === 3, "state4 cannot omit its accepted receipt");
    for (const path of ["data/generated/kg.json", "data/processed/news.json"]) files.set(path, await workingFile(root, path));
  }
  await compileOntologyFiles(root, { write: false });
  const ontology = json(await workingFile(root, "data/ontology.json"));
  const kg = json(files.get("data/generated/kg.json")); const news = json(files.get("data/processed/news.json"));
  const issues = [...validate(kg, ontology), ...validateNewsDataset(news), ...validateKnowledgeBaseNewsProjection(kg, news)];
  must(!issues.length, "receipt-bound rendered datasets fail semantic/structural validation");
  return files;
}

async function materializeAudit(directory, receipt, store) {
  must(store && typeof store.readBundle === "function", "read-only audit access is required; a receipt is not acceptance authority");
  const downloaded = await store.readBundle({ receipt: structuredClone(receipt) });
  must(downloaded?.files instanceof Map && equal([...downloaded.files.keys()].sort(), ARTIFACTS), "audit read-back has missing or unexpected artifact filenames");
  await mkdir(directory); let total = 0;
  for (const name of ARTIFACTS) {
    const content = downloaded.files.get(name); const expected = receipt.assets[name];
    must(Buffer.isBuffer(content) && content.length <= MAX_FILE && expected && content.length === expected.bytes && sha256(content) === expected.sha256, `audit artifact bytes differ: ${name}`);
    total += content.length; must(total <= MAX_BUNDLE, "audit bundle exceeds byte budget");
    await writeFile(resolve(directory, name), content, { flag: "wx", mode: 0o600 });
  }
  const verified = await verifyCandidateBundle(directory);
  must(!downloaded.manifest || equal(downloaded.manifest, verified.manifest), "downloaded manifest differs from its exact bytes");
  return verified;
}

/** A proposal receipt is never an accepted-checkpoint capability. Changed
 * receipts get independent replay rooted in the exact fetched main checkpoint. */
export async function validateMigrationPullRequest({ root, repository, baseCommit, headRepository = repository, store, acquireSource }) {
  root = resolve(root);
  must(COMMIT.test(baseCommit ?? ""), "exact PR base commit is required");
  const capability = await loadAcceptedGitCheckpoint({ root, repository, commit: baseCommit });
  const checkpoint = await readVerifiedAcceptedCheckpoint(capability);
  const head = await gitText(root, ["rev-parse", "HEAD"]);
  must(COMMIT.test(head) && !(await gitText(root, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"])), "PR tracked checkout must be clean");
  const reader = readerAt(root); const baseEntries = await reader.entries(baseCommit); const entries = await reader.entries(head);
  const baseReceipt = await blob(reader, baseEntries, RECEIPT, true);
  const receiptBytes = await blob(reader, entries, RECEIPT, true);
  if (receiptBytes) await assertWorkingBytes(root, reader, entries, RECEIPT, receiptBytes);
  const unchanged = baseReceipt === null ? receiptBytes === null : receiptBytes !== null && receiptBytes.equals(baseReceipt);
  if (unchanged) {
    await validateMigrationRendering(root, checkpoint.manifest);
    await readVerifiedAcceptedCheckpoint(capability);
    must(await gitText(root, ["rev-parse", "HEAD"]) === head && !(await gitText(root, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"])), "PR checkout changed during rendering validation");
    return { kind: "unchanged-receipt", baseCommit, headCommit: head, accepted: false, freshSourceReplay: false };
  }
  must(headRepository === repository, "semantic migration draft audit requires a same-repository maintainer branch with read access");
  must(checkpoint.manifest && receiptBytes, "only an existing accepted release can receive a coherent migration proposal");
  const receipt = json(receiptBytes); validateAcceptedReleaseStructure(receipt);
  must(receiptBytes.equals(encoded(receipt)) && receipt.mode === "migration", "changed PR receipt must be a canonical reviewed semantic migration");
  must(equal(receipt.predecessor, { commit: baseCommit, releaseId: checkpoint.manifest.releaseId, bundleId: checkpoint.manifest.candidateBundleId }), "migration predecessor is not the exact current accepted base");
  must(receipt.codeCommit !== baseCommit && await reader.isAncestor(baseCommit, receipt.codeCommit) && await reader.isAncestor(receipt.codeCommit, head), "proposed code must descend from accepted base and precede PR HEAD");
  must(receipt.auditReceipt.repository === repository && equal(receipt.source.repository, checkpoint.manifest.source.repository), "proposal audit/source repository differs from accepted base");
  const proposed = await reader.entries(receipt.codeCommit);
  must((await blob(reader, proposed, RECEIPT)).equals(baseReceipt), "proposed code ancestor must retain the accepted base receipt");
  for (const [path, content] of checkpoint.files) must((await blob(reader, proposed, path)).equals(content), `code proposal changed accepted outputs before generation: ${path}`);
  must(equal(proposed.get(SOURCE), baseEntries.get(SOURCE)), "code proposal changed source pointer before generation");
  const restricted = (map) => Object.fromEntries([...map].filter(([path]) => path === ".gitmodules" || path.startsWith(".github/workflows/")));
  must(equal(restricted(proposed), restricted(baseEntries)), "workflow or source-remote changes require separate review");
  const targets = new Set([...Object.keys(receipt.acceptedFiles), RECEIPT, SOURCE]);
  const nonTargets = (map) => Object.fromEntries([...map].filter(([path]) => !targets.has(path)));
  must(equal(nonTargets(entries), nonTargets(proposed)), "PR code/configuration changed after the reviewed proposal commit");
  const source = entries.get(SOURCE);
  must(source?.type === "commit" && source.mode === "160000" && source.oid === receipt.source.commit, "PR source pointer differs from reviewed candidate");
  const files = await validateMigrationRendering(root, receipt);
  for (const [path, content] of files) await assertWorkingBytes(root, reader, entries, path, content);
  for (const [name, binding] of Object.entries(receipt.configuration)) {
    for (const [path, expected] of name === "generator" ? Object.entries(binding.files) : [[binding.path, binding.sha256]]) {
      must(sha256(await blob(reader, proposed, path)) === expected, `proposed committed configuration differs: ${path}`);
    }
  }
  must(typeof acquireSource === "function", "read-only pinned source acquisition is required for independent PR replay");
  const temporary = await mkdtemp(resolve(tmpdir(), "migration-pr-validation-"));
  const worktree = resolve(temporary, "proposal"), auditDirectory = resolve(temporary, "audit"), sourceDirectory = resolve(temporary, "source");
  let added = false;
  try {
    const bundle = await materializeAudit(auditDirectory, receipt.auditReceipt, store);
    must(bundle.manifest.bundleId === receipt.candidateBundleId && sha256(canonicalJson(bundle.manifest)) === receipt.candidateManifestHash &&
      equal(bundle.manifest.inputs.reviewProposal, candidateProposalBinding(receipt.codeCommit)), "candidate audit does not bind proposed code and receipt");
    must(bundle.manifest.inputs.recipe.archiveCommit === receipt.source.commit && equal(bundle.manifest.inputs.transition, receipt.transition), "candidate source/review differs from PR receipt");
    await git(root, ["worktree", "add", "--detach", worktree, receipt.codeCommit]); added = true;
    const acquired = await acquireSource({ directory: sourceDirectory, repository: structuredClone(checkpoint.manifest.source.repository), commit: receipt.source.commit,
      includedRoots: [...receipt.source.includedRoots] });
    must(acquired === sourceDirectory && await realpath(acquired) === sourceDirectory, "source adapter must return the assigned isolated directory");
    const verified = await verifyAcceptedCandidate(worktree, auditDirectory, { source: sourceDirectory, checkpoint: capability, store, proposalCommit: receipt.codeCommit });
    must(verified.mode === "migration" && equal(verified.manifest, bundle.manifest), "independent replay differs from proposed migration");
    must(verified.acceptedFiles.size === files.size && [...verified.acceptedFiles].every(([path, content]) => files.get(path)?.equals(content)), "independently rebuilt accepted outputs differ from the PR bytes");
    const rebuilt = createAcceptedRelease({ candidateManifest: verified.manifest, lifecycle: verified.artifacts["lifecycle.json.gz"], acceptedFiles: verified.acceptedFiles,
      origin: verified.origin, predecessor: receipt.predecessor, codeCommit: receipt.codeCommit, sourceCommit: receipt.source.commit,
      auditReceipt: receipt.auditReceipt, mode: "migration", transition: verified.transition,
      verifiedPredecessor: { commit: baseCommit, manifest: checkpoint.manifest }, auditRepository: repository });
    must(equal(rebuilt, receipt), "PR receipt differs from independently verified reconstruction");
    await readVerifiedAcceptedCheckpoint(capability);
    must(await gitText(root, ["rev-parse", "HEAD"]) === head && !(await gitText(root, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"])), "PR checkout changed during independent replay");
    await validateMigrationRendering(root, receipt);
    for (const [path, content] of files) await assertWorkingBytes(root, readerAt(root), entries, path, content);
    await assertWorkingBytes(root, readerAt(root), entries, RECEIPT, receiptBytes);
    return { kind: "independently-verified-migration", baseCommit, headCommit: head, proposalCommit: receipt.codeCommit,
      releaseId: receipt.releaseId, bundleId: receipt.candidateBundleId, accepted: false, requiresReviewedMerge: true, freshSourceReplay: true };
  } finally {
    if (added) await git(root, ["worktree", "remove", "--force", worktree]);
    await rm(temporary, { recursive: true, force: true });
  }
}
