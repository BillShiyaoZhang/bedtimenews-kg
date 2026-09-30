import { readFile, mkdir, open, rename, lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "./candidate-bundle.mjs";
import { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint } from "./accepted-git.mjs";
import { buildAcceptedCandidate, verifyAcceptedCandidate } from "./accepted-candidate.mjs";
import { createAcceptedRelease } from "./accepted-release.mjs";
import { prepareAcceptedCommit, promoteAcceptedCommit } from "./release-promotion.mjs";

const must = (value, message) => { if (!value) throw new Error(`Release sync: ${message}`); };
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
export const RELEASE_NODE_VERSION = "22.23.2";
export const RELEASE_SOURCE_PATH = "sources/bedtimenews-archive-contents";

/** Activation and storage consent are independent; neither defaults to approved. */
export function assertReleaseApproval({ activated, storageRepository }, repository) {
  must(typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) && activated === true && storageRepository === repository, "disabled: explicit activation and repository-specific draft/storage/publication approval are required");
}

/** Fsynced local intent journal for process restarts on retained disks. Actions
 * additionally uses its existing run/attempt records as a conservative fence;
 * this file alone is not durable across replacement of an ephemeral runner. */
export async function createFileReleaseJournal(path, repository) {
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  must(await realpath(dirname(path)) === dirname(path), "journal directory must not have symlink ancestors");
  const empty = () => ({ schemaVersion: 1, repository, pendingOperations: [], promotion: null, pages: null });
  return {
    async read() {
      try {
        must((await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink(), "journal must be a regular file");
        const value = JSON.parse(await readFile(path, "utf8"));
        must(value.schemaVersion === 1 && value.repository === repository && Array.isArray(value.pendingOperations), "invalid or wrong-repository journal");
        return value;
      } catch (error) { if (error.code === "ENOENT") return empty(); throw error; }
    },
    async write(value) {
      must(value.schemaVersion === 1 && value.repository === repository, "wrong journal repository");
      const temporary = `${path}.${process.pid}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${canonicalJson(value)}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    },
  };
}

/** Bind release-store's persist-before-write callbacks to the durable journal. */
export async function releaseStoreJournalOptions(journal) {
  const state = await journal.read();
  return {
    pendingOperations: [...state.pendingOperations],
    async onMutationIntent(operation) {
      const current = await journal.read();
      must(!current.pendingOperations.includes(operation.operation), "unresolved mutation cannot be attempted again");
      current.pendingOperations.push(operation.operation);
      await journal.write(current);
    },
    async onMutationReconciled(operation) {
      const current = await journal.read();
      current.pendingOperations = current.pendingOperations.filter((item) => item !== operation.operation);
      await journal.write(current);
    },
  };
}

/** Own the complete acceptance boundary. Transport owns read-only main/source
 * acquisition; validatePrepared must run required tests/lint/builds on that exact
 * isolated commit. No accepted files or caller index are ever rewritten here. */
export async function syncAcceptedRelease({ root, repository, approval, journal, transport, store,
  acquireSource, validatePrepared, reconcilePages, sourceReview, recoverOnly = false, operation = "sync", rollbackCommit, rollbackReview, candidateOptions = {}, onProgress = () => {} }) {
  assertReleaseApproval(approval, repository);
  must(["sync", "rollback"].includes(operation), "unknown release operation");
  must(!candidateOptions.migrationReview, "semantic migrations require the coherent prepare-migration-pr path, not source-update main CAS");
  must(operation !== "rollback" || /^[a-f0-9]{40}$/u.test(rollbackCommit ?? "") && typeof rollbackReview === "string", "rollback requires an exact accepted commit and reviewed restoration file");
  must(journal && typeof journal.read === "function" && typeof journal.write === "function", "durable journal required");
  must(transport && typeof transport.fetchMain === "function" && typeof transport.readMain === "function", "main transport required");
  must(typeof reconcilePages === "function" && typeof validatePrepared === "function" && typeof acquireSource === "function", "complete validation, source and Pages adapters required");
  must(!Object.keys(candidateOptions).some((name) => ["checkpoint", "store", "source", "sourceReview", "rollbackCheckpoint", "rollbackReview", "proposalCommit"].includes(name)), "candidate options cannot override trust or source boundaries");
  const pinned = await transport.fetchMain();
  const capability = await loadAcceptedGitCheckpoint({ root, repository, commit: pinned });
  const checkpoint = await readVerifiedAcceptedCheckpoint(capability);
  let saved = await journal.read();
  must(saved.repository === repository && saved.schemaVersion === 1, "journal identity mismatch");
  const initialPromotion = saved.promotion;

  // Lost push responses are reconciled from immutable accepted Git, not from
  // serialised prepared descriptors or an unchanged remote (which is uncertain).
  if (initialPromotion && initialPromotion.status !== "complete") {
    const accepted = await loadAcceptedGitCheckpoint({ root, repository, commit: initialPromotion.commit, allowAncestor: true });
    const snapshot = await readVerifiedAcceptedCheckpoint(accepted);
    must(snapshot.manifest?.releaseId === initialPromotion.releaseId && snapshot.manifest.candidateBundleId === initialPromotion.bundleId,
      "saved promotion is not accepted on current main; read-only reconciliation required, do not retry the push");
    onProgress("Recovering an already accepted version before acquiring upstream sources");
    await store.publishAcceptedBundle({ checkpoint: accepted });
  }
  // Always finish/verify audit publication before fresh extraction. This works
  // with absent raw sources and does not claim a fresh source replay.
  if (checkpoint.manifest) await store.publishAcceptedBundle({ checkpoint: capability });
  if (recoverOnly || initialPromotion && initialPromotion.status !== "complete") {
    must(checkpoint.manifest, "no accepted release exists to recover");
    const pages = await reconcilePages({ commit: pinned, journal });
    saved = await journal.read();
    if (saved.promotion) saved.promotion.status = "complete";
    await journal.write(saved);
    return { status: "recovered", acceptedCommit: pinned, releaseId: checkpoint.manifest.releaseId, pages, freshSourceReplay: false };
  }
  saved = await journal.read();
  if (saved.pendingOperations.length && saved.candidate && typeof store.reconcilePending === "function") {
    await store.reconcilePending({ bundleDir: saved.candidate.directory, targetCommit: saved.candidate.targetCommit });
    saved = await journal.read();
  }
  must(saved.pendingOperations.length === 0, "unresolved audit mutations require read-only reconciliation before another candidate");
  let rollbackCapability = null; let rollbackTarget = null; let source;
  if (operation === "rollback") {
    must(checkpoint.manifest, "rollback requires a current accepted release");
    rollbackCapability = await loadAcceptedGitCheckpoint({ root, repository, commit: rollbackCommit, allowAncestor: true });
    rollbackTarget = await readVerifiedAcceptedCheckpoint(rollbackCapability);
    onProgress("Restoring verified accepted output bytes without claiming fresh raw-source replay");
  } else {
    source = await acquireSource({ checkpoint, bootstrap: checkpoint.manifest === null });
    onProgress(checkpoint.manifest ? "Fully rematerializing current graph from the pinned incremental source snapshot" : "Bootstrapping only the exact legacy accepted inventory");
  }
  const options = { ...candidateOptions, checkpoint: capability, store,
    ...(operation === "rollback" ? { rollbackCheckpoint: rollbackCapability, rollbackReview } : { source, ...(sourceReview ? { sourceReview } : {}) }) };
  const transitionAPI = operation === "rollback" ? await import("./accepted-candidate.mjs") : null;
  const candidate = operation === "rollback" ? await transitionAPI.buildAcceptedRollback(root, options) : await buildAcceptedCandidate(root, options);
  must(candidate.mode !== "migration", "semantic migrations require a coherent reviewed PR; no draft was staged");
  const verify = () => operation === "rollback" ? transitionAPI.verifyAcceptedRollback(root, candidate.output, options) : verifyAcceptedCandidate(root, candidate.output, options);
  if (candidate.noop) {
    must(checkpoint.manifest, "bootstrap cannot be a no-op");
    const pages = await reconcilePages({ commit: pinned, journal });
    return { status: "noop", acceptedCommit: pinned, releaseId: checkpoint.manifest.releaseId, bundleId: checkpoint.manifest.candidateBundleId, pages, freshSourceReplay: operation !== "rollback" };
  }
  // Exact audit bytes are already on disk. Do not keep a second parsed full
  // provenance ledger alive while the independent verifier rematerializes.
  candidate.artifacts = { "lifecycle.json.gz": candidate.artifacts["lifecycle.json.gz"] };
  await verify();
  saved = await journal.read();
  saved.candidate = { directory: candidate.output, targetCommit: pinned, bundleId: candidate.manifest.bundleId };
  await journal.write(saved);
  const auditReceipt = await store.stageBundle({ bundleDir: candidate.output, targetCommit: pinned });
  must(auditReceipt.visibilityAtReadback === "draft", "unaccepted candidate must remain a private draft");
  const previous = checkpoint.manifest;
  const manifest = createAcceptedRelease({ candidateManifest: candidate.manifest, lifecycle: candidate.artifacts["lifecycle.json.gz"], acceptedFiles: candidate.acceptedFiles,
    origin: candidate.origin, predecessor: previous ? { commit: pinned, releaseId: previous.releaseId, bundleId: previous.candidateBundleId } : null,
    codeCommit: pinned, sourceCommit: candidate.manifest.inputs.recipe.archiveCommit, auditReceipt,
    mode: candidate.mode ?? (previous ? "continuation" : "bootstrap"), transition: candidate.transition ?? null,
    rollbackTarget: rollbackTarget ? { commit: rollbackTarget.commit, releaseId: rollbackTarget.manifest.releaseId, bundleId: rollbackTarget.manifest.candidateBundleId } : null,
    verifiedRollbackTarget: rollbackTarget ? { commit: rollbackTarget.commit, manifest: rollbackTarget.manifest } : null,
    verifiedPredecessor: previous ? { commit: pinned, manifest: previous } : null, auditRepository: repository });
  const prepared = await prepareAcceptedCommit({ root, checkpoint: capability, manifest, candidateManifest: candidate.manifest,
    lifecycle: candidate.artifacts["lifecycle.json.gz"], acceptedFiles: candidate.acceptedFiles, ...(rollbackCapability ? { rollbackCheckpoint: rollbackCapability } : {}) });
  const validation = await validatePrepared({ prepared, candidate, manifest });
  // Validation may take minutes. Replay/recheck inputs and audit bytes again
  // immediately before the remote expected-base gate, not merely before builds.
  await verify();
  const finalReceipt = await store.verifyBundle({ bundleDir: candidate.output, targetCommit: pinned });
  must(equal(finalReceipt, auditReceipt), "draft audit changed during isolated validation");
  must(await transport.readMain({ repository, ref: "refs/heads/main" }) === pinned, "main advanced during validation; discard preparation");
  saved = await journal.read();
  saved.promotion = { status: "intent", commit: prepared.commit, expectedBase: pinned, releaseId: prepared.releaseId, bundleId: prepared.bundleId, payloadHash: prepared.payloadHash };
  await journal.write(saved); // Must finish durably before the sole push attempt.
  const promoted = await promoteAcceptedCommit({ prepared, transport });
  must(promoted.accepted === true, `promotion ${promoted.status}; saved intent requires read-only reconciliation, never a blind retry`);
  const freshMain = await transport.fetchMain();
  must(freshMain === prepared.commit, "main advanced after acceptance; rerun recovery without creating another version");
  const fresh = await loadAcceptedGitCheckpoint({ root, repository, commit: freshMain });
  await store.publishAcceptedBundle({ checkpoint: fresh });
  const pages = await reconcilePages({ commit: freshMain, journal });
  saved = await journal.read(); saved.promotion.status = "complete"; await journal.write(saved);
  return { status: "accepted", acceptedCommit: freshMain, releaseId: manifest.releaseId, bundleId: manifest.candidateBundleId, pages, freshSourceReplay: operation !== "rollback", ...(validation ? { validation } : {}) };
}

/** Prepare a coherent proposed-code + regenerated-data PR commit. This path
 * never publishes, dispatches, pushes, or moves an accepted/proposal branch. Only a separately
 * reviewed ordinary PR merge can establish acceptance of its returned commit. */
export async function prepareMigrationPullRequest({ root, repository, approval, journal, transport, store,
  proposalCommit, proposalRef, migrationReview, source = resolve(root, RELEASE_SOURCE_PATH), sourceReview,
  validatePrepared, candidateOptions = {}, onProgress = () => {} }) {
  assertReleaseApproval(approval, repository);
  must(typeof migrationReview === "string" && migrationReview.length > 0, "an exact reviewed semantic migration file is required");
  must(typeof validatePrepared === "function" && journal && typeof journal.read === "function" && typeof journal.write === "function", "complete validation and retained mutation journal required");
  must(!Object.keys(candidateOptions).some((name) => ["checkpoint", "store", "source", "sourceReview", "migrationReview", "rollbackCheckpoint", "rollbackReview", "proposalCommit"].includes(name)), "candidate options cannot override proposal trust or review boundaries");
  const { inspectReviewedMigrationProposal, prepareReviewedMigrationCommit } = await import("./release-promotion.mjs");
  const pinned = await transport.fetchMain();
  const capability = await loadAcceptedGitCheckpoint({ root, repository, commit: pinned });
  const checkpoint = await readVerifiedAcceptedCheckpoint(capability);
  must(checkpoint.manifest, "a semantic migration PR requires an accepted predecessor");
  const inspect = () => inspectReviewedMigrationProposal({ root, checkpoint: capability, proposalCommit, proposalRef });
  await inspect();
  let saved = await journal.read();
  must(saved.schemaVersion === 1 && saved.repository === repository, "proposal journal identity mismatch");
  if (saved.pendingOperations.length && saved.candidate && typeof store.reconcilePending === "function") {
    await store.reconcilePending({ bundleDir: saved.candidate.directory, targetCommit: saved.candidate.targetCommit });
    saved = await journal.read();
  }
  must(saved.pendingOperations.length === 0, "unresolved draft mutations require read-only reconciliation before preparing a PR");
  const options = { ...candidateOptions, checkpoint: capability, store, source, migrationReview, proposalCommit, ...(sourceReview ? { sourceReview } : {}) };
  onProgress("Replaying the reviewed proposed-code migration against exact accepted main");
  const candidate = await buildAcceptedCandidate(root, options);
  must(!candidate.noop && candidate.mode === "migration", "PR preparation requires changed semantic/runtime axes and an exact migration review");
  candidate.artifacts = { "lifecycle.json.gz": candidate.artifacts["lifecycle.json.gz"] };
  await verifyAcceptedCandidate(root, candidate.output, options);
  await inspect();
  must(await transport.readMain({ repository, ref: "refs/heads/main" }) === pinned, "main advanced before proposal draft staging");
  saved = await journal.read(); saved.candidate = { directory: candidate.output, targetCommit: proposalCommit, bundleId: candidate.manifest.bundleId }; await journal.write(saved);
  const auditReceipt = await store.stageBundle({ bundleDir: candidate.output, targetCommit: proposalCommit });
  must(auditReceipt.visibilityAtReadback === "draft", "unmerged migration must remain a private draft");
  const previous = checkpoint.manifest;
  const manifest = createAcceptedRelease({ candidateManifest: candidate.manifest, lifecycle: candidate.artifacts["lifecycle.json.gz"], acceptedFiles: candidate.acceptedFiles,
    origin: candidate.origin, predecessor: { commit: pinned, releaseId: previous.releaseId, bundleId: previous.candidateBundleId },
    codeCommit: proposalCommit, sourceCommit: candidate.manifest.inputs.recipe.archiveCommit, auditReceipt,
    mode: "migration", transition: candidate.transition, verifiedPredecessor: { commit: pinned, manifest: previous }, auditRepository: repository });
  const prepared = await prepareReviewedMigrationCommit({ root, checkpoint: capability, proposalCommit, proposalRef, manifest,
    candidateManifest: candidate.manifest, lifecycle: candidate.artifacts["lifecycle.json.gz"], acceptedFiles: candidate.acceptedFiles });
  const validation = await validatePrepared({ prepared, candidate, manifest });
  await verifyAcceptedCandidate(root, candidate.output, options);
  must(equal(await store.verifyBundle({ bundleDir: candidate.output, targetCommit: proposalCommit }), auditReceipt), "proposal draft changed during isolated validation");
  await inspect();
  must(await transport.readMain({ repository, ref: "refs/heads/main" }) === pinned, "main advanced during PR preparation; re-review the proposal against current main");
  saved = await journal.read(); saved.preparedPR = prepared; await journal.write(saved);
  return { status: "prepared-for-review", accepted: false, requiresReviewedMerge: true, prepared,
    releaseId: manifest.releaseId, bundleId: manifest.candidateBundleId, freshSourceReplay: true, ...(validation ? { validation } : {}) };
}
