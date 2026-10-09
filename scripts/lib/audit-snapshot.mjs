import { lstat, open, readdir, realpath } from "node:fs/promises";
import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { constants } from "node:fs";
import { resolve } from "node:path";

export const SNAPSHOT_FILES = Object.freeze(["diff.json", "kg.json", "lifecycle.json.gz", "manifest.json", "news.json", "provenance.json.gz", "source-review.json"]);
const SHA = /^[a-f0-9]{40}$/u, HASH = /^[a-f0-9]{64}$/u;
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const must = (value, message) => { if (!value) throw new Error(`Audit snapshot: ${message}`); };
async function boundedFile(path, limit) {
  must(Number.isSafeInteger(limit) && limit >= 0 && limit <= 129 * 1024 * 1024, "invalid read limit");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    must(before.isFile() && before.nlink === 1 && before.size <= limit, "unsafe bounded file");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      must(bytesRead > 0, "truncated file"); offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await lstat(path);
    must(!extra.bytesRead && after.isFile() && after.nlink === 1 && after.dev === before.dev
      && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs, "file changed during read");
    return bytes;
  } finally { await handle.close(); }
}
export async function readSnapshotMetadata(directory) {
  return JSON.parse(await boundedFile(resolve(directory, "snapshot.json"), 128 * 1024));
}

export function snapshotProducer(run) {
  return { runId: run.id, runAttempt: run.run_attempt, workflowId: run.workflow_id,
    workflowPath: run.path, workflowSha: run.head_sha, actorId: run.actor.id };
}
export const snapshotName = (bundleId) => { must(HASH.test(bundleId), "invalid bundle key"); return `kg-audit-snapshot-${bundleId}`; };

export function validateProductionPlan(plan, { policy, baseCommit }) {
  must(plan && same(Object.keys(plan).sort(), ["actor", "bundleId", "expectedMain", "files", "generatedAt", "kind", "migrationReview", "migrationReviewSha256", "proposalCommit", "proposalRef", "reason", "repository", "reviewedAt", "runtime", "schemaVersion", "sourceCommit", "storageApproved"]), "unexpected production plan fields");
  must(plan?.schemaVersion === 1 && plan.kind === "reviewed-audit-production-plan", "unsupported production plan");
  must(plan.repository === policy.repository && plan.expectedMain === baseCommit && SHA.test(baseCommit)
    && SHA.test(plan.proposalCommit) && SHA.test(plan.sourceCommit) && HASH.test(plan.bundleId)
    && /^refs\/heads\/[A-Za-z0-9_/-]+$/u.test(plan.proposalRef) && plan.proposalRef !== "refs/heads/main", "plan identities differ");
  must(plan.storageApproved === true && same(plan.actor, policy.actor)
    && typeof plan.reason === "string" && plan.reason.trim().length > 0 && plan.reason.length <= 4096
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(plan.reviewedAt) && Number.isFinite(Date.parse(plan.reviewedAt)), "plan lacks reviewed authorization");
  must(same(plan.runtime, { node: "22.23.2", npm: "10.9.9", locale: "en-US", timeZone: "UTC" }), "wrong runtime");
  must(typeof plan.generatedAt === "string" && Number.isFinite(Date.parse(plan.generatedAt)), "invalid recipe time");
  must(plan.migrationReview?.kind === "semantic-migration" && HASH.test(plan.migrationReviewSha256)
    && sha256(`${canonicalJson(plan.migrationReview)}\n`) === plan.migrationReviewSha256, "review bytes differ");
  must(same(Object.keys(plan.files ?? {}).sort(), SNAPSHOT_FILES), "plan must bind all seven files");
  let total = 0;
  for (const [name, binding] of Object.entries(plan.files)) {
    must(same(Object.keys(binding).sort(), ["bytes", "sha256"]) && HASH.test(binding.sha256)
      && Number.isSafeInteger(binding.bytes) && binding.bytes >= 0 && binding.bytes <= (name === "manifest.json" ? 1024 * 1024 : 128 * 1024 * 1024), "invalid file binding");
    total += binding.bytes;
  }
  must(total <= 129 * 1024 * 1024, "plan exceeds audit budget");
  return plan;
}

/** Candidate receipt is only a locator. Authority comes from GitHub run identity
 * and the exact base's trusted producer code, never PR-supplied run IDs/URLs. */
export async function discoverSnapshotArtifacts({ api, policy, baseCommit, receipt }) {
  must(SHA.test(baseCommit) && receipt.repository === policy.repository, "wrong repository/base");
  const workflow = await api(`/actions/workflows/${policy.workflowPath.split("/").at(-1)}`);
  must(Number.isSafeInteger(workflow.id) && workflow.path === policy.workflowPath, "workflow identity differs");
  const found = []; let seen = 0, total = null;
  for (let page = 1; page <= policy.maximumPages; page++) {
    const result = await api(`/actions/artifacts?name=${snapshotName(receipt.bundleId)}&per_page=100&page=${page}`);
    must(Number.isSafeInteger(result.total_count) && Array.isArray(result.artifacts), "invalid artifact page");
    if (total === null) total = result.total_count;
    must(total === result.total_count && total <= policy.maximumPages * 100, "artifact listing changed or exceeds bound");
    for (const artifact of result.artifacts) {
      seen++; must(artifact.name === snapshotName(receipt.bundleId), "artifact search mismatch");
      const runId = artifact.workflow_run?.id;
      if (!Number.isSafeInteger(runId) || artifact.workflow_run.head_sha !== baseCommit) continue;
      const run = await api(`/actions/runs/${runId}`);
      must(run.id === runId, "run API identity differs");
      if (run.workflow_id !== workflow.id || run.path !== policy.workflowPath || run.head_sha !== baseCommit
        || run.head_branch !== "main" || run.event !== "workflow_dispatch" || run.run_attempt !== 1
        || run.status !== "completed" || run.conclusion !== "success" || run.actor?.id !== policy.actor.id
        || run.actor?.login !== policy.actor.login || run.triggering_actor?.id !== policy.actor.id
        || run.repository?.full_name !== policy.repository || run.head_repository?.full_name !== policy.repository) continue;
      must(artifact.workflow_run.repository_id === run.repository.id && artifact.workflow_run.head_repository_id === run.repository.id, "artifact repository differs");
      must(Number.isSafeInteger(artifact.id) && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0
        && artifact.size_in_bytes <= policy.maximumArchiveBytes && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? ""), "invalid artifact archive binding");
      must(typeof artifact.expired === "boolean" && Number.isFinite(Date.parse(artifact.expires_at)), "missing artifact expiry");
      if (!artifact.expired && Date.parse(artifact.expires_at) > Date.now()) found.push({ artifact, run });
    }
    if (seen === total) break;
    must(result.artifacts.length === 100 && seen < total && page < policy.maximumPages, "incomplete artifact listing");
  }
  must(seen === total && found.length > 0 && new Set(found.map(({ artifact }) => artifact.id)).size === found.length, "no complete unexpired trusted snapshot");
  return found.sort((a, b) => a.artifact.id - b.artifact.id);
}

export async function validateSnapshotDirectory({ directory, policy, baseCommit, receipt, producer, approvedPlanBytes }) {
  directory = resolve(directory);
  must(await realpath(directory) === directory, "snapshot directory is redirected");
  for (const name of [...SNAPSHOT_FILES, "snapshot.json"]) {
    const stat = await lstat(`${directory}/${name}`);
    must(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && stat.size <= (name === "snapshot.json" ? 128 * 1024 : receipt.assets[name]?.bytes), "unsafe snapshot file");
  }
  must(same((await readdir(directory)).sort(), [...SNAPSHOT_FILES, "snapshot.json"].sort()), "unexpected snapshot file");
  const bytes = await boundedFile(`${directory}/snapshot.json`, 128 * 1024);
  must(bytes.length <= 128 * 1024, "snapshot metadata exceeds bound");
  const snapshot = JSON.parse(bytes);
  must(bytes.equals(Buffer.from(`${canonicalJson(snapshot)}\n`)) && snapshot.schemaVersion === 1 && snapshot.kind === "verified-audit-snapshot", "noncanonical snapshot");
  must(same(Object.keys(snapshot).sort(), ["kind", "operation", "plan", "planCommit", "planSha256", "producer", "receipt", "schemaVersion", "verification"]), "unexpected snapshot fields");
  validateProductionPlan(snapshot.plan, { policy, baseCommit });
  must(Buffer.isBuffer(approvedPlanBytes) && approvedPlanBytes.equals(Buffer.from(`${canonicalJson(snapshot.plan)}\n`)), "snapshot plan differs from approved Git bytes");
  must(SHA.test(snapshot.planCommit) && HASH.test(snapshot.planSha256)
    && sha256(`${canonicalJson(snapshot.plan)}\n`) === snapshot.planSha256, "plan hash differs");
  must(same(snapshot.receipt, receipt) && snapshot.plan.bundleId === receipt.bundleId && snapshot.plan.proposalCommit === receipt.targetCommit
    && receipt.repository === policy.repository && receipt.readbackVerified === true && receipt.visibilityAtReadback === "draft", "receipt differs from verified production");
  must(same(snapshot.producer, producer), "snapshot producer identity differs");
  must(["produce", "verify"].includes(snapshot.operation), "unknown snapshot operation");
  if (snapshot.operation === "produce") must(snapshot.verification === null, "production cannot assert final-head verification");
  else {
    const verification = snapshot.verification;
    must(SHA.test(verification?.combinedHead) && verification.proposalCommit === snapshot.plan.proposalCommit
      && verification.baseCommit === baseCommit && verification.liveReceiptVerified === true && verification.semanticReplayVerified === false
      && verification.receiptSha256 === sha256(canonicalJson(receipt)), "final live verification evidence differs");
  }
  for (const name of SNAPSHOT_FILES) must(receipt.assets[name]?.bytes === snapshot.plan.files[name].bytes
    && receipt.assets[name]?.sha256 === snapshot.plan.files[name].sha256, "receipt/plan bytes differ");
  // Seven data files are exposed through a separate view by the caller; read
  // them here without admitting snapshot.json as part of the audit manifest.
  const files = new Map();
  for (const name of SNAPSHOT_FILES) {
    const content = await boundedFile(`${directory}/${name}`, receipt.assets[name].bytes);
    must(content.length === receipt.assets[name].bytes && sha256(content) === receipt.assets[name].sha256, "snapshot payload differs");
    files.set(name, content);
  }
  const manifest = JSON.parse(files.get("manifest.json")); const { bundleId, ...payload } = manifest;
  must(files.get("manifest.json").equals(Buffer.from(`${canonicalJson(manifest)}\n`)) && bundleId === receipt.bundleId
    && manifest.schemaVersion === 1 && manifest.kind === "offline-candidate"
    && same(Object.keys(manifest.artifacts).sort(), SNAPSHOT_FILES.filter((name) => name !== "manifest.json"))
    && sha256(canonicalJson(payload)) === bundleId && sha256(files.get("manifest.json")) === receipt.manifestSha256, "manifest identity differs");
  for (const name of SNAPSHOT_FILES.filter((name) => name !== "manifest.json")) must(same(manifest.artifacts[name], snapshot.plan.files[name]), "manifest file binding differs");
  must(manifest.inputs.reviewProposal.commit === snapshot.plan.proposalCommit && manifest.inputs.recipe.archiveCommit === snapshot.plan.sourceCommit
    && manifest.inputs.recipe.generatedAt === snapshot.plan.generatedAt
    && same(manifest.inputs.transition.review, snapshot.plan.migrationReview), "manifest proposal/recipe differs");
  return snapshot;
}

/** Precisely two receipts. Snapshot transport cannot authorize arbitrary local
 * receipts, replace accepted Git authority, or fall back after corruption. */
export function createSnapshotSplitStore({ candidateReceipt, candidateStore, predecessorReceipt, publishedStore }) {
  const candidate = canonicalJson(candidateReceipt), predecessor = canonicalJson(predecessorReceipt);
  must(candidate !== predecessor, "ambiguous snapshot receipt");
  return Object.freeze({ async readBundle({ receipt }) {
    const key = canonicalJson(receipt);
    if (key === candidate) return candidateStore.readBundle({ receipt });
    must(key === predecessor, "unrecognized audit receipt");
    return publishedStore.readBundle({ receipt });
  } });
}
