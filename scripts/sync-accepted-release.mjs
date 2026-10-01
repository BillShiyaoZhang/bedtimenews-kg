#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseApproval, RELEASE_NODE_VERSION, syncAcceptedRelease, releaseStoreJournalOptions, createFileReleaseJournal } from "./lib/release-sync.mjs";
import { createGitHubReleaseStore } from "./lib/release-store.mjs";
import { createReleaseGitTransport, acquireReleaseSource, validatePreparedRelease, createReleaseGitHubClient, reconcileReleasePages, createActionsReleaseMutationGuard, describeActionsHistoryFailure, inspectAcceptedReleaseRecovery } from "./lib/release-runtime.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repository = process.env.GITHUB_REPOSITORY;
const approval = { activated: process.env.KG_RELEASE_ACTIVATED === "true", storageRepository: process.env.KG_RELEASE_STORAGE_APPROVED };
assertReleaseApproval(approval, repository);
const runtime = new Intl.DateTimeFormat().resolvedOptions();
if (process.versions.node !== RELEASE_NODE_VERSION || runtime.timeZone !== "UTC" || runtime.locale !== "en-US") {
  throw new Error(`Release sync: production requires Node ${RELEASE_NODE_VERSION}, en-US locale, UTC timezone; local benchmark runtime cannot create production versions`);
}
const args = process.argv.slice(2);
const prefixes = ["--source-review=", "--target=", "--rollback-review="];
if (args.some((arg) => !["--recover-only", "--rollback"].includes(arg) && !prefixes.some((prefix) => arg.startsWith(prefix)))) throw new Error("Use --recover-only, --source-review=path, or --rollback --target=SHA --rollback-review=path");
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const rollbackCommit = option("target") || process.env.KG_RELEASE_ROLLBACK_COMMIT;
const operation = args.includes("--rollback") || rollbackCommit ? "rollback" : "sync";
const rollbackReview = option("rollback-review") || process.env.KG_RELEASE_ROLLBACK_REVIEW;
if (operation === "rollback" && (!/^[a-f0-9]{40}$/u.test(rollbackCommit ?? "") || !rollbackReview)) throw new Error("Rollback requires an exact accepted --target=SHA and --rollback-review=path");
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const { request, github, repo } = createReleaseGitHubClient({ repository, token });
let guard = { blockedAttempts: [], assertMutationAllowed() {} };
if (process.env.GITHUB_ACTIONS === "true") {
  try {
    guard = await createActionsReleaseMutationGuard({ repository, request, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      resolvedAttempts: process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? process.env.KG_RELEASE_RESOLVED_ATTEMPTS : "" });
  } catch (error) {
    console.error(`Actions history verification failed: ${JSON.stringify(describeActionsHistoryFailure(error))}`);
    guard = { blockedAttempts: ["history-unverified"], assertMutationAllowed() { throw new Error("Actions history could not establish restart safety"); } };
  }
}
const guardedFetch = (url, options = {}) => {
  if (!["GET", "HEAD"].includes(options.method ?? "GET")) guard.assertMutationAllowed();
  return globalThis.fetch(url, options);
};
const transport = createReleaseGitTransport(root, { repository });
const push = transport.pushFastForward.bind(transport);
transport.pushFastForward = async (options) => { guard.assertMutationAllowed(); return push(options); };
const dispatch = github.rest.actions.createWorkflowDispatch;
github.rest.actions.createWorkflowDispatch = async (options) => { guard.assertMutationAllowed(); return dispatch(options); };
if (guard.blockedAttempts.length) console.log(`Read-only recovery: unresolved prior release attempts ${guard.blockedAttempts.join(", ")}`);
const journal = await createFileReleaseJournal(resolve(root, "work/release-sync-journal.json"), repository);
const store = createGitHubReleaseStore({ ...repo, token, fetchImpl: guardedFetch, ...await releaseStoreJournalOptions(journal) });
let summary = "";
const core = { info: console.log, summary: { addRaw(value) { summary += value; return this; }, async write() {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary); summary = "";
} } };
if (guard.blockedAttempts.length) {
  const report = await inspectAcceptedReleaseRecovery({ root, repository, transport, store, request, github, repo });
  console.log(JSON.stringify({ ...report, blockedAttempts: guard.blockedAttempts }));
  await core.summary.addRaw(`Release sync blocked by unresolved attempts: ${guard.blockedAttempts.join(", ")}\nAccepted main: ${report.acceptedCommit ?? "unverified"}; audit publication: ${report.auditPublication}; Pages: ${report.pages}\n`).write();
  process.exitCode = 1;
} else {
  try {
    const result = await syncAcceptedRelease({ root, repository, approval, journal, store,
      transport, acquireSource: (options) => acquireReleaseSource(root, options),
      validatePrepared: (options) => validatePreparedRelease(root, options, { onProgress: console.log }),
      reconcilePages: ({ commit }) => reconcileReleasePages({ github, core, repo, journal, commit }),
      recoverOnly: args.includes("--recover-only") || process.env.KG_RELEASE_RECOVER_ONLY === "true", sourceReview: option("source-review") || process.env.KG_RELEASE_SOURCE_REVIEW,
      operation, rollbackCommit, rollbackReview,
      onProgress: console.log });
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `target_sha=${result.acceptedCommit}\nrelease_status=${result.status}\ncoverage_outcome=${result.validation?.coverage ?? "not-run"}\n`);
  } catch (error) {
    const report = await inspectAcceptedReleaseRecovery({ root, repository, transport, store, request, github, repo });
    console.log(JSON.stringify(report));
    await core.summary.addRaw(`Release sync incomplete. Accepted main: ${report.acceptedCommit ?? "unverified"}; audit publication: ${report.auditPublication}; Pages: ${report.pages}\n`).write();
    throw error;
  }
}
