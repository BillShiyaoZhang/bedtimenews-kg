#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson, sha256 } from "./lib/candidate-bundle.mjs";
import { createGitHubReleaseStore, prepareAuditBundle } from "./lib/release-store.mjs";
import { createUploadRecoveryReservation } from "./lib/upload-recovery-journal.mjs";
import { assertReleaseApproval, RELEASE_NODE_VERSION } from "./lib/release-sync.mjs";

const execFile = promisify(execFileCallback);
const operatorRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const must = (value) => { if (!value) throw new Error("Preflight rejected"); };
let phase = "arguments";
async function git(root, args) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  return (await execFile("git", ["--no-replace-objects", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, ...args],
    { env, maxBuffer: 1024 * 1024 })).stdout.trim();
}
async function bytesAt(path, maxBytes) {
  const stat = await lstat(path);
  must(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maxBytes && await realpath(path) === path);
  const bytes = await readFile(path); must(bytes.length <= maxBytes); return bytes;
}
try {
  const args = process.argv.slice(2);
  must(args.filter((arg) => arg.startsWith("--approval=")).length === 1 && args.filter((arg) => arg === "--execute").length <= 1
    && args.every((arg) => arg === "--execute" || arg.startsWith("--approval=")));
  const execute = args.includes("--execute");
  const approvalPath = resolve(args.find((arg) => arg.startsWith("--approval=")).slice(11));
  phase = "runtime";
  const runtime = new Intl.DateTimeFormat().resolvedOptions();
  must(process.versions.node === RELEASE_NODE_VERSION && runtime.locale === "en-US" && runtime.timeZone === "UTC" && process.env.GITHUB_ACTIONS !== "true");
  const repository = process.env.GITHUB_REPOSITORY;
  assertReleaseApproval({ activated: process.env.KG_RELEASE_ACTIVATED === "true", storageRepository: process.env.KG_RELEASE_STORAGE_APPROVED }, repository);
  phase = "approval";
  const approvalBytes = await bytesAt(approvalPath, 32 * 1024); const approval = JSON.parse(approvalBytes);
  must(approvalBytes.equals(Buffer.from(`${canonicalJson(approval)}\n`)) && approval.repository === repository
    && /^[a-f0-9]{40}$/u.test(approval.recoveryCodeCommit ?? "") && /^[a-f0-9]{40}$/u.test(approval.targetCommit ?? ""));
  const migrationRoot = dirname(dirname(approval.originalJournalPath));
  must(approval.originalJournalPath === resolve(migrationRoot, "work/migration-pr-journal.json")
    && approval.recoveryDirectory === resolve(migrationRoot, "work/upload-recovery") && operatorRoot !== migrationRoot);
  phase = "operator-code";
  must(await git(operatorRoot, ["rev-parse", "--show-toplevel"]) === operatorRoot
    && await git(operatorRoot, ["rev-parse", "HEAD"]) === approval.recoveryCodeCommit
    && !(await git(operatorRoot, ["status", "--porcelain", "--untracked-files=all"])));
  // This operational checkout may differ from the frozen proposal only in the
  // reviewed recovery implementation, its tests and its operator documentation.
  const allow = new Set(["scripts/lib/release-store.mjs", "scripts/lib/upload-recovery-journal.mjs", "scripts/recover-audit-upload.mjs", "tests/release-store.test.mjs", "docs/upload-recovery.md"]);
  const changed = (await git(operatorRoot, ["diff", "--name-only", approval.targetCommit, "HEAD"])).split("\n").filter(Boolean);
  must(changed.length > 0 && changed.every((path) => allow.has(path)));
  phase = "migration-checkout";
  must(await realpath(migrationRoot) === migrationRoot && await git(migrationRoot, ["rev-parse", "--show-toplevel"]) === migrationRoot
    && await git(migrationRoot, ["rev-parse", "HEAD"]) === approval.targetCommit
    && await git(migrationRoot, ["symbolic-ref", "HEAD"]) === approval.proposalRef
    && !(await git(migrationRoot, ["status", "--porcelain", "--untracked-files=all"])));
  for (const root of [operatorRoot, migrationRoot]) must([`https://github.com/${repository}`, `https://github.com/${repository}.git`].includes(await git(root, ["config", "--get", "remote.origin.url"])));
  phase = "original-journal";
  const journalBytes = await bytesAt(approval.originalJournalPath, 64 * 1024);
  must(sha256(journalBytes) === approval.originalJournalSha256);
  const journal = JSON.parse(journalBytes);
  must(journal.schemaVersion === 1 && journal.repository === repository && journal.candidate?.bundleId === approval.bundleId
    && journal.candidate?.targetCommit === approval.targetCommit && canonicalJson(journal.pendingOperations) === canonicalJson([approval.operation]));
  const bundleDir = journal.candidate.directory;
  must(dirname(bundleDir) === resolve(migrationRoot, "work/accepted"));
  const bundle = await prepareAuditBundle(bundleDir);
  const sourcePath = "sources/bedtimenews-archive-contents";
  must(await git(migrationRoot, ["rev-parse", `HEAD:${sourcePath}`]) === bundle.manifest.inputs.recipe.archiveCommit
    && await git(resolve(migrationRoot, sourcePath), ["rev-parse", "HEAD"]) === bundle.manifest.inputs.recipe.archiveCommit);
  const [owner, repo] = repository.split("/");
  const store = createGitHubReleaseStore({ owner, repo, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    pendingOperations: journal.pendingOperations, fetchImpl: (url, options = {}) => {
      if (!execute && !["GET", "HEAD"].includes(options.method ?? "GET")) throw new Error("Read-only preflight");
      return globalThis.fetch(url, options);
    } });
  phase = execute ? "explicit-recovery" : "read-only-preflight";
  const reserveAttempt = execute ? createUploadRecoveryReservation({ directory: approval.recoveryDirectory, originalJournalPath: approval.originalJournalPath })
    : async () => { throw new Error("No reservation in read-only preflight"); };
  // Read-only mode uses the complete binding/remote inspector but cannot reserve
  // an attempt. Missing assets produce JOURNAL_ERROR at that deliberate boundary.
  let result;
  try { result = await store.recoverPendingUpload({ bundleDir, targetCommit: approval.targetCommit, approval, reserveAttempt }); }
  catch (error) { if (!execute && error.code === "JOURNAL_ERROR") result = { state: "requires-explicit-recovery" }; else throw error; }
  console.log(JSON.stringify({ status: execute ? "recovery-result" : "checked-not-executed", approvalSha256: sha256(approvalBytes), repository,
    recoveryCodeCommit: approval.recoveryCodeCommit, expectedMain: approval.expectedMain, proposalCommit: approval.targetCommit,
    releaseId: approval.releaseId, bundleId: approval.bundleId, asset: approval.asset, originalJournalSha256: approval.originalJournalSha256, result }));
} catch (error) {
  const allowed = new Set(["UNCERTAIN_MUTATION", "JOURNAL_ERROR", "IMMUTABLE_CONFLICT", "READBACK_MISMATCH", "HTTP_ERROR", "REQUEST_FAILED", "REQUEST_TIMEOUT", "UNSAFE_URL"]);
  console.error(JSON.stringify({ status: "stopped", phase, code: allowed.has(error.code) ? error.code : "PREFLIGHT_FAILED",
    ...([400, 401, 403, 404, 408, 422, 429, 500, 502, 503, 504].includes(error.requestStatus ?? error.status) ? { requestStatus: error.requestStatus ?? error.status } : {}),
    ...(["api.github.com", "uploads.github.com", "audit-download"].includes(error.requestHost) ? { requestHost: error.requestHost } : {}),
    ...(["GET", "HEAD", "POST", "PATCH"].includes(error.requestMethod) ? { requestMethod: error.requestMethod } : {}),
    ...(typeof error.githubRequestId === "string" && /^[A-Fa-f0-9]{1,16}(?::[A-Fa-f0-9]{1,16}){4}$/u.test(error.githubRequestId) ? { githubRequestId: error.githubRequestId } : {}) }));
  process.exitCode = 1;
}
