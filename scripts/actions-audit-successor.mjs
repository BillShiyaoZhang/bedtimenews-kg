#!/usr/bin/env node
// Explicit Actions adapter. The local prepare/recovery guards remain unchanged.
// No proposal imports, package installation, shell commands with credentials,
// or executable artifacts are permitted in this fresh writer runner.
import { readFile, lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const must = (v) => { if (!v) throw new Error("Actions successor rejected"); };
const hash = (b) => createHash("sha256").update(b).digest("hex");
const root = resolve(import.meta.dirname, "..");
const evidenceDir = `${root}/audit-recovery/stage-h`;
const git = (...args) => execFileSync("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
  encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" }, maxBuffer: 1024 * 1024 }).trim();
try {
  const authorityBytes = await readFile(`${evidenceDir}/authority.json`);
  const authority = JSON.parse(authorityBytes);
  const env = process.env; const runtime = new Intl.DateTimeFormat().resolvedOptions();
  must(env.GITHUB_ACTIONS === "true" && env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_RUN_ATTEMPT === "1"
    && process.versions.node === "22.23.2" && runtime.locale === "en-US" && runtime.timeZone === "UTC");
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH));
  must(event.inputs?.source_review === hash(authorityBytes));
  must(/^[a-f0-9]{40}$/u.test(authority.operatorCommit) && git("rev-parse", "HEAD") === env.GITHUB_SHA
    && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA && !git("status", "--porcelain", "--untracked-files=all"));
  git("merge-base", "--is-ancestor", authority.operatorCommit, "HEAD");
  must(git("diff", "--name-only", authority.operatorCommit, "HEAD") === "audit-recovery/stage-h/authority.json");
  for (const [path, expected] of Object.entries(authority.codeFiles)) {
    must(/^(?:scripts\/|audit-recovery\/stage-h\/|\.github\/workflows\/|package(?:-lock)?\.json$|\.node-version$)/u.test(path) && !path.includes(".."));
    const stat = await lstat(`${root}/${path}`); must(stat.isFile() && !stat.isSymbolicLink());
    must(hash(await readFile(`${root}/${path}`)) === expected);
  }
  const { canonicalJson, sha256 } = await import("./lib/candidate-bundle.mjs");
  must(authorityBytes.equals(Buffer.from(`${canonicalJson(authority)}\n`)));
  const scope = JSON.parse(await readFile(`${evidenceDir}/scope.json`));
  must(scope.repository === env.GITHUB_REPOSITORY && scope.repository === "BillShiyaoZhang/bedtimenews-kg"
    && scope.successorOrdinal === 1 && scope.originalState === "unknown" && scope.oldRecoveryBudget === "exhausted"
    && scope.exhaustedRecoveryAdjudication === "rejected-401-original-still-unknown"
    && env.GITHUB_REF === "refs/heads/fix/actions-audit-successor-20261009"
    && env.GITHUB_WORKFLOW_REF === `${scope.repository}/.github/workflows/sync-archive.yml@${env.GITHUB_REF}`
    && env.KG_RELEASE_ACTIVATED === "true" && env.KG_RELEASE_STORAGE_APPROVED === scope.repository);
  must(String(scope.actor.id) === env.GITHUB_ACTOR_ID && scope.actor.login === env.GITHUB_ACTOR && scope.actor.login === env.GITHUB_TRIGGERING_ACTOR);
  const token = env.GH_TOKEN; must(typeof token === "string" && token.length > 0);
  // Every API request is one attempt; no retry middleware and no redirects.
  const api = async (path, { method = "GET", body, missing = false, status } = {}) => {
    must(path.startsWith("/") && !path.includes(".."));
    const response = await fetch(`https://api.github.com/repos/${scope.repository}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: canonicalJson(body) } : {}) });
    if (missing && response.status === 404) return null;
    must(status ? response.status === status : response.ok);
    return response.json();
  };
  const runInfo = await api(`/actions/runs/${env.GITHUB_RUN_ID}`);
  must(runInfo.head_sha === env.GITHUB_SHA && runInfo.event === "workflow_dispatch" && runInfo.run_attempt === 1
    && runInfo.path === ".github/workflows/sync-archive.yml" && runInfo.actor.id === scope.actor.id
    && runInfo.triggering_actor.id === scope.actor.id && runInfo.head_branch === "fix/actions-audit-successor-20261009");
  const run = { id: runInfo.id, attempt: 1, workflowSha: env.GITHUB_SHA, operatorCommit: authority.operatorCommit, actorId: scope.actor.id };
  const evidence = { scope, authority, authoritySha256: hash(authorityBytes), originals: {} };
  for (const [name, expected] of Object.entries(scope.evidence)) {
    must(/^[a-z-]+\.json$/u.test(name)); const bytes = await readFile(`${evidenceDir}/${name}`);
    must(hash(bytes) === expected); evidence.originals[name] = bytes.toString("utf8");
  }
  const journal = JSON.parse(evidence.originals["original-journal.json"]);
  const priorApproval = JSON.parse(evidence.originals["exhausted-intent.json"]);
  const priorOutcome = JSON.parse(evidence.originals["exhausted-outcome.json"]);
  must(priorOutcome.requestStatus === 401 && priorOutcome.requestHost === "uploads.github.com" && priorOutcome.requestMethod === "POST"
    && priorOutcome.githubRequestId === "E34F:3B29C3:104169:253666:6AC8C9A4" && priorOutcome.state === "unknown"
    && journal.pendingOperations.length === 1 && journal.pendingOperations[0] === priorApproval.operation
    && priorOutcome.operation === priorApproval.operation && priorApproval.originalJournalSha256 === scope.evidence["original-journal.json"]
    && priorApproval.releaseId === scope.releaseId && priorApproval.targetCommit === scope.proposalCommit && priorApproval.expectedMain === scope.expectedMain);
  const bundleDir = resolve(env.AUDIT_BUNDLE_DIRECTORY);
  must(JSON.stringify((await readdir(bundleDir)).sort()) === JSON.stringify(Object.keys(scope.files).sort()));
  for (const [name, binding] of Object.entries(scope.files)) {
    const stat = await lstat(`${bundleDir}/${name}`); must(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === binding.bytes);
    must(hash(await readFile(`${bundleDir}/${name}`)) === binding.sha256);
  }
  const checkFrozen = async () => {
    const main = await api("/git/ref/heads/main"); const proposal = await api(`/git/ref/${scope.proposalRef.slice(5)}`);
    const release = await api(`/releases/${scope.releaseId}`);
    must(main.object.sha === scope.expectedMain && proposal.object.sha === scope.proposalCommit
      && release.id === scope.releaseId && release.draft && !release.immutable && release.target_commitish === scope.proposalCommit
      && release.tag_name === `kg-audit-${scope.bundleId}`);
  };
  await checkFrozen();
  const { createActionsUploadFence } = await import("./lib/actions-upload-fence.mjs");
  const fence = createActionsUploadFence({ api, scope, run, authoritySha256: hash(authorityBytes) });
  await fence.retainEvidence(evidence); // Required even if the asset already exists.
  const { createGitHubReleaseStore } = await import("./lib/release-store.mjs");
  const [owner, repo] = scope.repository.split("/");
  const { runActionsAuditUpload, createObservedUploadTransport } = await import("./lib/actions-audit-upload.mjs");
  const observed = createObservedUploadTransport({ scope });
  const receipt = await runActionsAuditUpload({ scope, priorApproval, journal, bundleDir, checkFrozen, fence,
    assertHealthy: observed.assertHealthy,
    createStore: (options) => createGitHubReleaseStore({ owner, repo, token, fetchImpl: observed.fetchImpl, ...options }) });
  await fence.retainEvidence({ kind: "verified-seven-asset-receipt", authoritySha256: hash(authorityBytes), receipt });
  console.log(JSON.stringify({ status: "verified", releaseId: scope.releaseId, bundleId: scope.bundleId, receiptSha256: sha256(canonicalJson(receipt)), assets: Object.keys(receipt.assets).length }));
} catch (error) {
  // Never expose arbitrary exception messages, request URLs, headers or bodies.
  console.error(JSON.stringify({ status: "stopped", code: ["UNCERTAIN_MUTATION", "JOURNAL_ERROR", "IMMUTABLE_CONFLICT", "READBACK_MISMATCH", "HTTP_ERROR"].includes(error.code) ? error.code : "ADAPTER_REJECTED",
    ...([401, 403, 422, 502].includes(error.requestStatus ?? error.status) ? { requestStatus: error.requestStatus ?? error.status } : {}),
    ...(["api.github.com", "uploads.github.com"].includes(error.requestHost) ? { requestHost: error.requestHost } : {}),
    ...(error.requestMethod === "POST" ? { requestMethod: "POST" } : {}),
    ...(typeof error.githubRequestId === "string" && /^[A-Fa-f0-9:]{5,90}$/u.test(error.githubRequestId) ? { githubRequestId: error.githubRequestId } : {}) }));
  process.exitCode = 1;
}
