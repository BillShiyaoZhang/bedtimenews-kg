import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalJson, sha256, diffKnowledgeGraphs, diffRecords, publishCandidateBundle, verifyCandidateBundle } from "./candidate-bundle.mjs";
import { activeSnapshot, candidateVersions, candidateRuntimeBinding, sourceInventory, assertCandidateOutput, assertBaselineUnchanged, CANDIDATE_STORAGE_BUDGET } from "./candidate-run.mjs";
import { lifecycleCandidateSettings, lifecycleCandidateInputs, planLifecycleSources, materializeLifecycleCandidate, assertLifecycleArtifacts, assertLifecycleBudget } from "./lifecycle-run.mjs";
import { summarizeCandidateLifecycleInput, buildCandidateLifecycle } from "./candidate-lifecycle.mjs";
import { isSourceReviewTimestamp } from "./candidate-source-review.mjs";
import { assertGitSourceInventory, readGitSourceHead } from "./source-snapshot.mjs";
import { classifyAcceptedRelease, createAcceptedArchiveState, REQUIRED_ACCEPTED_PATHS, validateAcceptedReleaseFiles } from "./accepted-release.mjs";
import { readVerifiedAcceptedCheckpoint } from "./accepted-git.mjs";
import { compileOntology } from "./ontology-compiler.mjs";
import { acceptedSemanticSnapshot, semanticAxes, migrationReviewBinding, validateMigrationReview, assertMigrationNewsContinuity, rollbackReviewBinding, validateRollbackReview, rollbackSourcePlan } from "./accepted-transition.mjs";
import { buildAcceptedReports } from "./accepted-reports.mjs";
import { actionAssessmentDiff } from "./action-reporting.mjs";

const must = (value, message) => { if (!value) throw new Error(`Accepted candidate: ${message}`); };
const hash = (value) => sha256(canonicalJson(value));
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const clone = (value) => JSON.parse(canonicalJson(value));
const bytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const fileBinding = (value) => ({ sha256: sha256(value), bytes: value.length });
const names = ["diff.json", "kg.json", "lifecycle.json.gz", "news.json", "provenance.json.gz", "source-review.json"];
const originNames = ["acceptedKG", "acceptedNews", "acceptedState"];
const variableInputs = new Set(["recipe", "sourceInventory", "effectiveInventory", "baselineCandidate", "sourceReview", "verification", "transition", "reviewProposal"]);
const fixedInputs = (inputs) => Object.fromEntries(Object.entries(inputs).filter(([name]) => !variableInputs.has(name)));
export const ACCEPTED_CANDIDATE_VERSION = "3.0.0";
export const ACCEPTED_VERIFICATION_VERSION = "1.0.0";

export function candidateProposalBinding(commit) {
  must(/^[a-f0-9]{40}$/u.test(commit ?? ""), "proposalCommit must be an exact committed code identity");
  const value = { commit };
  return { ...value, sha256: hash(value) };
}

function checkOptions(options, hooks) {
  must(!Object.hasOwn(options, "baseline") && !Object.hasOwn(options, "receipt") && !Object.hasOwn(options, "verified") && !Object.hasOwn(options, "origin"), "local baselines, receipts, origin objects and trust flags cannot establish accepted checkpoint authority");
  must(Object.keys(hooks).every((name) => ["afterInputSnapshot", "afterNewsRegeneration", "beforeVerifyReturn", "beforePublish"].includes(name) && typeof hooks[name] === "function"), "invalid test hooks");
}
function json(content, name) {
  try {
    const decoded = name.endsWith(".gz") ? gunzipSync(content, { maxOutputLength: 512 * 1024 * 1024 }) : content;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch (error) { throw new Error(`Accepted candidate: invalid checkpoint artifact ${name}`, { cause: error }); }
}
function trustedFingerprint(checkpoint) {
  must(checkpoint && checkpoint.files instanceof Map && checkpoint.origin?.bytes, "trusted Git checkpoint bytes are unavailable");
  return hash({ commit: checkpoint.commit, repository: checkpoint.repository, manifest: checkpoint.manifest,
    files: Object.fromEntries([...checkpoint.files].map(([name, value]) => [name, fileBinding(value)])),
    origin: { commit: checkpoint.origin.commit, bindings: checkpoint.origin.bindings,
      bytes: Object.fromEntries(originNames.map((name) => [name, fileBinding(checkpoint.origin.bytes[name])])) } });
}
export function candidateVerificationBinding(checkpoint, { rollbackTarget = null } = {}) {
  const payload = { version: ACCEPTED_VERIFICATION_VERSION, kind: rollbackTarget ? "trusted-git-checkpoint-accepted-output-restore" : "trusted-git-checkpoint-full-current-replay", originCommit: checkpoint.origin.commit,
    checkpoint: checkpoint.manifest ? { commit: checkpoint.commit, releaseId: checkpoint.manifest.releaseId, bundleId: checkpoint.manifest.candidateBundleId, manifestHash: hash(checkpoint.manifest) } : null };
  if (rollbackTarget) payload.rollbackTarget = { commit: rollbackTarget.commit, releaseId: rollbackTarget.manifest.releaseId, bundleId: rollbackTarget.manifest.candidateBundleId, manifestHash: hash(rollbackTarget.manifest) };
  return { ...payload, sha256: hash(payload) };
}
function versions(context, dataset) {
  return { ...candidateVersions({ ontology: context.ontology, rules: context.rules, dataset }), candidate: ACCEPTED_CANDIDATE_VERSION, lifecycle: "1.0.0" };
}

/** Hash validation supplements, and never replaces, the opaque Git authority. */
async function readCheckpointBundle(checkpoint, store) {
  const release = checkpoint.manifest;
  if (!release) return null;
  validateAcceptedReleaseFiles(release, checkpoint.files);
  must(store && typeof store.readBundle === "function", "accepted checkpoint requires audit bundle read-back");
  const downloaded = await store.readBundle({ receipt: clone(release.auditReceipt) });
  must(downloaded?.files instanceof Map, "audit recovery did not return exact bundle bytes");
  const files = new Map([...downloaded.files].map(([name, content]) => [name, Buffer.from(content)]));
  must(equal([...files.keys()].sort(), [...names, "manifest.json"].sort()), "checkpoint audit has missing or unknown files");
  for (const [name, content] of files) {
    const receipt = release.auditReceipt.assets[name];
    must(receipt && equal(fileBinding(content), { sha256: receipt.sha256, bytes: receipt.bytes }), `checkpoint audit receipt mismatch: ${name}`);
  }
  const manifest = json(files.get("manifest.json"), "manifest.json");
  must(files.get("manifest.json").equals(bytes(manifest)), "checkpoint manifest is not canonical");
  const { bundleId, ...payload } = manifest;
  must(manifest.schemaVersion === 1 && manifest.kind === "offline-candidate" && hash(payload) === bundleId && bundleId === release.candidateBundleId && hash(manifest) === release.candidateManifestHash, "checkpoint candidate identity mismatch");
  must(!downloaded.manifest || equal(downloaded.manifest, manifest), "audit recovery manifest differs from its bytes");
  must(equal(Object.keys(manifest.artifacts).sort(), names), "checkpoint audit is not a full lifecycle bundle");
  assertLifecycleBudget(manifest);
  const artifacts = {};
  for (const name of names) {
    must(equal(fileBinding(files.get(name)), manifest.artifacts[name]), `checkpoint candidate artifact mismatch: ${name}`);
    artifacts[name] = json(files.get(name), name);
  }
  must(manifest.versions.candidate === ACCEPTED_CANDIDATE_VERSION && manifest.versions.lifecycle === "1.0.0", "accepted checkpoint needs an explicit candidate/verification migration");
  const verification = manifest.inputs.verification;
  must(verification?.version === ACCEPTED_VERIFICATION_VERSION && verification.kind === (release.mode === "rollback" ? "trusted-git-checkpoint-accepted-output-restore" : "trusted-git-checkpoint-full-current-replay"), "checkpoint lacks the versioned verification contract");
  const { sha256: verificationHash, ...verificationPayload } = verification;
  must(verificationHash === hash(verificationPayload) && verification.originCommit === release.origin.commit, "checkpoint verification identity mismatch");
  must(equal(manifest.versions, release.versions) && equal(manifest.inputs.runtime, release.runtime), "checkpoint accepted version/runtime mismatch");
  must(equal(manifest.inputs.transition ?? null, release.transition), "checkpoint accepted transition mismatch");
  if (manifest.inputs.reviewProposal) must(equal(manifest.inputs.reviewProposal, candidateProposalBinding(release.codeCommit)) && release.mode === "migration", "checkpoint proposal code binding mismatch");
  for (const [name, binding] of Object.entries(release.configuration)) must(equal(manifest.inputs[name], binding), `checkpoint configuration mismatch: ${name}`);
  for (const name of originNames) must(equal(manifest.inputs[name], checkpoint.origin.bindings[name]), `checkpoint frozen origin mismatch: ${name}`);
  must(equal(release.origin, { commit: checkpoint.origin.commit, bindings: checkpoint.origin.bindings }), "checkpoint original accepted origin mismatch");
  const lifecycle = artifacts["lifecycle.json.gz"];
  const inventoryBinding = (inventory) => ({ sha256: hash(inventory), fileCount: Object.keys(inventory).length });
  must(equal(release.inventories, { observed: inventoryBinding(lifecycle.observedInventory), effective: inventoryBinding(lifecycle.effectiveInventory), sourceStatesHash: hash(lifecycle.sourceStates) }), "checkpoint lifecycle inventory mismatch");
  must(equal(manifest.inputs.sourceInventory, release.inventories.observed) && equal(manifest.inputs.effectiveInventory, release.inventories.effective), "checkpoint input inventory mismatch");
  must(sha256(files.get("source-review.json")) === manifest.inputs.sourceReview.sha256, "checkpoint review input mismatch");
  must(manifest.inputs.recipe.archiveCommit === release.source.commit && equal(manifest.inputs.recipe.includedRoots, release.source.includedRoots), "checkpoint source recipe mismatch");
  for (const [name, path] of [["kg.json", REQUIRED_ACCEPTED_PATHS[0]], ["news.json", REQUIRED_ACCEPTED_PATHS[1]]]) must(equal(json(checkpoint.files.get(path), path), artifacts[name]), `checkpoint rendered output differs from audit: ${name}`);
  const baseline = { manifest, kg: artifacts["kg.json"], news: artifacts["news.json"], lifecycle,
    summary: summarizeCandidateLifecycleInput({ kg: artifacts["kg.json"], news: artifacts["news.json"], provenance: artifacts["provenance.json.gz"] }) };
  // Retain the compact derivation summary, not a second 196 MB parsed ledger,
  // while rebuilding/replaying the next full corpus. Exact bytes stay pinned.
  delete artifacts["provenance.json.gz"];
  return { ...baseline, artifacts, files };
}

async function receiptBytesAt(root) {
  try { return await readFile(resolve(root, "data/accepted-release.json")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function prepare(root, options, hooks, { allowMigration = false, sourceFree = false } = {}) {
  // The Git module rejects lookalikes. No local manifest, self-rehashed receipt,
  // or caller-provided boolean is ever promoted to an authority capability.
  const checkpoint = await readVerifiedAcceptedCheckpoint(options.checkpoint);
  must(options.proposalCommit === undefined || /^[a-f0-9]{40}$/u.test(options.proposalCommit), "proposalCommit must be an exact committed code identity");
  must(checkpoint.allowAncestor === false && checkpoint.mainCommit === checkpoint.commit, "current checkpoint must be exact accepted main, never an ancestor capability");
  const trustedHash = trustedFingerprint(checkpoint);
  const activeReceipt = await receiptBytesAt(root);
  must(checkpoint.manifest ? activeReceipt !== null && equal(json(activeReceipt, "accepted-release.json"), checkpoint.manifest) : activeReceipt === null,
    "active accepted receipt differs from trusted Git checkpoint");
  const baseline = await readCheckpointBundle(checkpoint, options.store);
  let context;
  if (sourceFree) {
    const snapshot = await activeSnapshot(root);
    const { ontology, rules } = compileOntology(snapshot.json("ontologySource"), snapshot.json("patterns"));
    must(snapshot.bytes.ontology.toString("utf8") === `${JSON.stringify(ontology, null, 2)}\n` && snapshot.bytes.rules.toString("utf8") === `${JSON.stringify(rules, null, 2)}\n`, "compiled ontology/rules are stale or hand-edited");
    const state = snapshot.json("acceptedState");
    context = { root, sourceRoot: resolve(root, options.source ?? "sources/bedtimenews-archive-contents"), historyRoot: resolve(root, options.historyRoot ?? "work/accepted"),
      snapshot, ontology, rules, state, includedRoots: [...state.includedRoots].sort(), runtime: candidateRuntimeBinding(), report: options.onProgress ?? (() => {}) };
    await hooks.afterInputSnapshot?.();
  } else context = await lifecycleCandidateSettings(root, { ...options, historyRoot: options.historyRoot ?? "work/accepted" }, hooks);
  const active = context.snapshot;
  for (const [path, content] of checkpoint.files) must((await readFile(resolve(root, path))).equals(content), `active accepted input differs from trusted Git checkpoint: ${path}`);
  for (const name of originNames) must(sha256(checkpoint.origin.bytes[name]) === checkpoint.origin.bindings[name].sha256, `trusted original byte binding mismatch: ${name}`);
  // Only original accepted inputs are frozen. Active accepted outputs remain a
  // separately pinned race gate, and the current lifecycle comes from the receipt.
  const frozenBytes = { ...active.bytes, ...checkpoint.origin.bytes };
  context.snapshot = { inputs: { ...acceptedSemanticSnapshot(active).inputs, ...clone(checkpoint.origin.bindings) }, bytes: frozenBytes,
    json: (name) => json(frozenBytes[name], name) };
  const originState = context.snapshot.json("acceptedState");
  must(equal([...originState.includedRoots].sort(), context.includedRoots), "immutable origin scope differs from current accepted scope");
  if (!baseline) must(equal(context.state, originState), "bootstrap accepted state differs from original trusted state");
  else {
    must(equal(context.includedRoots, checkpoint.manifest.source.includedRoots), "accepted checkpoint scope mismatch");
    const previous = baseline.manifest.inputs;
    const expectedFixed = { ...context.snapshot.inputs, runtime: context.runtime };
    if (!allowMigration) {
      must(equal(fixedInputs(previous), expectedFixed), "semantic configuration, frozen origin, generator or runtime changed; explicit migration required");
      must(equal(versions(context, baseline.news), baseline.manifest.versions), "candidate version changed; explicit migration required");
    }
  }
  return { ...context, active, activeReceipt, checkpoint, trustedHash, baseline, capability: options.checkpoint, proposalCommit: options.proposalCommit,
    origin: { commit: checkpoint.origin.commit, bindings: clone(checkpoint.origin.bindings) } };
}

async function inputsFor(context, inventory, effective, recipe, reviewBytes) {
  const inputs = await lifecycleCandidateInputs(context, inventory, effective, recipe, context.baseline?.manifest, reviewBytes);
  inputs.verification = candidateVerificationBinding(context.checkpoint);
  if (context.transition) inputs.transition = context.transition;
  if (context.proposalCommit) inputs.reviewProposal = candidateProposalBinding(context.proposalCommit);
  return inputs;
}
async function recheck(context, inventory, recipe, reviewFile, reviewBytes, directory, manifest) {
  must(equal(candidateRuntimeBinding(), context.runtime), "runtime changed during accepted candidate operation");
  must(equal((await activeSnapshot(context.root)).inputs, context.active.inputs), "active semantic configuration or accepted data changed during candidate operation");
  for (const [path, content] of context.checkpoint.files) must((await readFile(resolve(context.root, path))).equals(content), `accepted input changed during candidate operation: ${path}`);
  const currentReceipt = await receiptBytesAt(context.root);
  must(context.activeReceipt === null ? currentReceipt === null : currentReceipt !== null && currentReceipt.equals(context.activeReceipt), "active accepted receipt changed during candidate operation");
  const trusted = await readVerifiedAcceptedCheckpoint(context.capability);
  must(trustedFingerprint(trusted) === context.trustedHash, "trusted accepted checkpoint changed during candidate operation");
  if (reviewFile) must((await readFile(reviewFile)).equals(reviewBytes), "source review changed during candidate operation");
  if (context.migrationReviewFile) must((await readFile(context.migrationReviewFile)).equals(context.migrationReviewBytes), "migration review changed during candidate operation");
  const currentHead = await readGitSourceHead({ sourceRoot: context.sourceRoot });
  must(currentHead.commit === recipe.archiveCommit, "source HEAD changed during candidate operation");
  must(equal(await sourceInventory(context.sourceRoot, context.includedRoots, { allowEmpty: true }), inventory), "source inventory changed during candidate operation");
  await assertGitSourceInventory({ sourceRoot: context.sourceRoot, commit: recipe.archiveCommit, inventory, includedRoots: context.includedRoots });
  if (directory) await assertBaselineUnchanged(context.root, directory, manifest);
}
function releaseSnapshot(manifest, artifacts) {
  return { candidateManifest: manifest, kg: artifacts["kg.json"], news: artifacts["news.json"], lifecycle: artifacts["lifecycle.json.gz"] };
}
function acceptedFiles(context, manifest, artifacts) {
  const state = createAcceptedArchiveState({ previousState: context.state, candidateManifest: manifest, lifecycle: artifacts["lifecycle.json.gz"], sourceCommit: manifest.inputs.recipe.archiveCommit, ontologyCompilation: artifacts["kg.json"].source.ontologyCompilation });
  return new Map([[REQUIRED_ACCEPTED_PATHS[0], bytes(artifacts["kg.json"])], [REQUIRED_ACCEPTED_PATHS[1], bytes(artifacts["news.json"])], [REQUIRED_ACCEPTED_PATHS[2], bytes(state)],
    ...buildAcceptedReports({ candidateManifest: manifest, artifacts, previousKG: context.baseline?.kg ?? context.snapshot.json("acceptedKG"), ontology: context.ontology })]);
}
function resultContext(context) {
  return { origin: context.origin, checkpoint: context.checkpoint.manifest ? { commit: context.checkpoint.commit, manifest: context.checkpoint.manifest } : null,
    mode: context.transition?.kind === "reviewed-semantic-migration" ? "migration" : context.checkpoint.manifest ? "continuation" : "bootstrap", transition: context.transition ?? null };
}
function metrics(start, artifacts, manifest) {
  return { elapsedMs: Math.round(performance.now() - start), maxRssKiB: process.resourceUsage().maxRSS, historyBundles: 0,
    news: artifacts["news.json"].news.length, entities: artifacts["kg.json"].entities.length,
    supports: artifacts["provenance.json.gz"].supports.length, artifactBytes: Object.values(manifest.artifacts).reduce((sum, item) => sum + item.bytes, 0) };
}

async function readMigrationReview(root, context, path) {
  if (!path) return null;
  context.migrationReviewFile = resolve(root, path);
  context.migrationReviewBytes = await readFile(context.migrationReviewFile);
  return json(context.migrationReviewBytes, "migration-review.json");
}
function migrationBinding(context, inputs, labels, artifacts) {
  if (!context.baseline) return null;
  const binding = migrationReviewBinding({ checkpoint: context.checkpoint, previous: context.baseline, inputs, versions: labels, diff: artifacts["diff.json"] });
  if (binding.fromHash !== binding.toHash) assertMigrationNewsContinuity(context.baseline, { news: artifacts["news.json"], lifecycle: artifacts["lifecycle.json.gz"] });
  return binding;
}
function applyMigrationReview(context, inputs, binding, review) {
  if (!binding) { must(review === null, "bootstrap cannot use a migration review"); return; }
  if (binding.fromHash === binding.toHash) { must(review === null, "migration review is unused; semantic/runtime axes did not change"); return; }
  must(review !== null, "semantic/runtime axes changed; an exact reviewed migration is required");
  context.transition = validateMigrationReview(review, binding);
  inputs.transition = context.transition;
}

/** Full-current replay from a trusted accepted checkpoint; never writes accepted files. */
async function buildAccepted(root, options = {}, hooks = {}, previewMigration = false) {
  checkOptions(options, hooks); const start = performance.now();
  const context = await prepare(resolve(root), options, hooks, { allowMigration: Boolean(options.migrationReview) || previewMigration });
  const migrationReview = await readMigrationReview(root, context, options.migrationReview);
  const inventory = await sourceInventory(context.sourceRoot, context.includedRoots, { allowEmpty: true });
  const reviewFile = options.sourceReview ? resolve(root, options.sourceReview) : null;
  const reviewBytes = reviewFile ? await readFile(reviewFile) : Buffer.from("null\n");
  const review = json(reviewBytes, "source-review.json");
  const plan = planLifecycleSources(context, context.baseline, inventory, review);
  const { commit, committedAt } = await readGitSourceHead({ sourceRoot: context.sourceRoot });
  const generatedAt = options.generatedAt ?? committedAt;
  must(isSourceReviewTimestamp(generatedAt), "valid pinned generatedAt required");
  const recipe = { includedRoots: context.includedRoots, archiveCommit: commit, generatedAt, storageBudget: CANDIDATE_STORAGE_BUDGET };
  const inputs = await inputsFor(context, inventory, plan.effectiveInventory, recipe, reviewBytes);
  await recheck(context, inventory, recipe, reviewFile, reviewBytes);
  context.report("fully rebuild current source snapshot from trusted accepted checkpoint");
  let artifacts = await materializeLifecycleCandidate(context, recipe, plan, inputs, context.baseline, review);
  await hooks.afterNewsRegeneration?.();
  await recheck(context, inventory, recipe, reviewFile, reviewBytes);
  const labels = versions(context, artifacts["news.json"]);
  const binding = migrationBinding(context, inputs, labels, artifacts);
  if (previewMigration) {
    must(binding && binding.fromHash !== binding.toHash, "migration preview requires changed semantic/runtime axes");
    assertLifecycleArtifacts(artifacts, await materializeLifecycleCandidate(context, recipe, plan, inputs, context.baseline, review));
    await recheck(context, inventory, recipe, reviewFile, reviewBytes);
    return { mode: "migration-preview", accepted: false, reviewBinding: binding, diff: artifacts["diff.json"],
      elapsedMs: Math.round(performance.now() - start) };
  }
  applyMigrationReview(context, inputs, binding, migrationReview);
  const classification = classifyAcceptedRelease({ previous: context.baseline ? releaseSnapshot(context.baseline.manifest, context.baseline.artifacts) : null,
    current: { inputs, kg: artifacts["kg.json"], news: artifacts["news.json"], lifecycle: artifacts["lifecycle.json.gz"] } });
  if (!classification.hasChanges) {
    // Parent movement, source commit and generatedAt alone cannot mint versions.
    // Still replay and check all current raw bytes before claiming honest reuse.
    let expected = await materializeLifecycleCandidate(context, recipe, plan, inputs, context.baseline, review);
    assertLifecycleArtifacts(artifacts, expected);
    expected = null;
    await hooks.beforePublish?.();
    await recheck(context, inventory, recipe, reviewFile, reviewBytes);
    const completedMetrics = metrics(start, artifacts, context.baseline.manifest);
    artifacts = null;
    const restored = { ...context.baseline.artifacts,
      "provenance.json.gz": json(context.baseline.files.get("provenance.json.gz"), "provenance.json.gz") };
    return { noop: true, existing: true, output: null, manifest: context.baseline.manifest,
      artifacts: restored, acceptedFiles: new Map(context.checkpoint.files), classification,
      ...resultContext(context), metrics: completedMetrics };
  }
  const output = resolve(root, options.output ?? resolve(context.historyRoot, hash(inputs).slice(0, 20)));
  must(dirname(output) === context.historyRoot && !basename(output).startsWith("."), "output must be a direct non-hidden child of history-root");
  assertCandidateOutput(root, output, context.sourceRoot);
  let verifiedBundleId = null;
  const result = await publishCandidateBundle(output, { inputs, versions: labels, artifacts: { ...artifacts, "source-review.json": reviewBytes },
    validate: async ({ artifacts: actual, manifest }) => {
      assertLifecycleBudget(manifest);
      must(equal(manifest.inputs, inputs) && equal(manifest.versions, labels), "publication recipe mismatch");
      await recheck(context, inventory, recipe, reviewFile, reviewBytes);
      if (verifiedBundleId !== manifest.bundleId) {
        context.report("independently replay current materialization before isolated publication");
        assertLifecycleArtifacts(actual, await materializeLifecycleCandidate(context, recipe, plan, inputs, context.baseline, review));
        verifiedBundleId = manifest.bundleId;
      }
      return [];
    },
  }, { beforePublish: async () => { await hooks.beforePublish?.(); await recheck(context, inventory, recipe, reviewFile, reviewBytes); } });
  return { ...result, output, noop: false, artifacts, acceptedFiles: acceptedFiles(context, result.manifest, artifacts), classification,
    ...resultContext(context), metrics: metrics(start, artifacts, result.manifest) };
}

export function buildAcceptedCandidate(root, options = {}, hooks = {}) { return buildAccepted(root, options, hooks); }
/** Read-only preview: no candidate publication, acceptance, or approval flag. */
export function previewAcceptedMigration(root, options = {}, hooks = {}) { return buildAccepted(root, options, hooks, true); }

/** Separate v3 verifier. D's offline full-ancestry verifier is unchanged. */
export async function verifyAcceptedCandidate(root, directory, options = {}, hooks = {}) {
  checkOptions(options, hooks);
  const target = resolve(root, directory);
  const bundle = await verifyCandidateBundle(target);
  const context = await prepare(resolve(root), options, hooks, { allowMigration: Boolean(options.migrationReview) || bundle.manifest.inputs.transition?.kind === "reviewed-semantic-migration" });
  assertCandidateOutput(root, target, context.sourceRoot);
  const migrationReview = await readMigrationReview(root, context, options.migrationReview) ?? bundle.manifest.inputs.transition?.review ?? null;
  must(!bundle.manifest.inputs.transition || bundle.manifest.inputs.transition.kind === "reviewed-semantic-migration", "rendered rollback requires the separate accepted-output verifier");
  assertLifecycleBudget(bundle.manifest);
  must(bundle.manifest.versions.candidate === ACCEPTED_CANDIDATE_VERSION && bundle.manifest.versions.lifecycle === "1.0.0", "candidate needs the explicit v3 checkpoint verifier");
  const stored = bundle.manifest.inputs.recipe;
  must(stored && equal(Object.keys(stored).sort(), ["archiveCommit", "generatedAt", "includedRoots", "sha256", "storageBudget"]), "recipe has unknown or missing fields");
  const { sha256: recipeHash, ...recipe } = stored;
  must(recipeHash === hash(recipe) && equal(recipe.includedRoots, context.includedRoots) && equal(recipe.storageBudget, CANDIDATE_STORAGE_BUDGET) && isSourceReviewTimestamp(recipe.generatedAt), "invalid pinned recipe");
  const inventory = await sourceInventory(context.sourceRoot, context.includedRoots, { allowEmpty: true });
  const reviewFile = options.sourceReview ? resolve(root, options.sourceReview) : resolve(target, "source-review.json");
  const reviewBytes = await readFile(reviewFile);
  must(sha256(reviewBytes) === bundle.manifest.inputs.sourceReview.sha256, "verification source review differs from pinned bytes");
  const review = json(reviewBytes, "source-review.json");
  const plan = planLifecycleSources(context, context.baseline, inventory, review);
  const inputs = await inputsFor(context, inventory, plan.effectiveInventory, recipe, reviewBytes);
  await recheck(context, inventory, recipe, reviewFile, reviewBytes, target, bundle.manifest);
  const expected = await materializeLifecycleCandidate(context, recipe, plan, inputs, context.baseline, review);
  applyMigrationReview(context, inputs, migrationBinding(context, inputs, versions(context, expected["news.json"]), expected), migrationReview);
  must(equal(inputs, bundle.manifest.inputs), "candidate input/checkpoint binding mismatch");
  must(equal(versions(context, expected["news.json"]), bundle.manifest.versions), "candidate version labels mismatch");
  assertLifecycleArtifacts(bundle.artifacts, expected);
  await hooks.beforeVerifyReturn?.();
  await recheck(context, inventory, recipe, reviewFile, reviewBytes, target, bundle.manifest);
  return { manifest: bundle.manifest, artifacts: bundle.artifacts, acceptedFiles: acceptedFiles(context, bundle.manifest, expected),
    ...resultContext(context), historyBundles: 0, verificationVersion: ACCEPTED_VERIFICATION_VERSION };
}

async function rollbackContext(root, options, hooks) {
  must(!options.sourceReview && !options.migrationReview, "rollback cannot combine source or semantic migration reviews");
  const context = await prepare(root, options, hooks, { sourceFree: true });
  must(context.baseline, "rollback requires a currently accepted release");
  const target = await readVerifiedAcceptedCheckpoint(options.rollbackCheckpoint);
  must(target.manifest && target.repository === context.checkpoint.repository && equal(target.origin.bindings, context.checkpoint.origin.bindings) && target.origin.commit === context.checkpoint.origin.commit,
    "rollback target must share the current accepted repository and frozen origin");
  must(target.allowAncestor === true && target.mainCommit === context.checkpoint.mainCommit && target.mainCommit === context.checkpoint.commit, "rollback target must be an ancestor checkpoint pinned to the current accepted main");
  must(target.manifest.epochId === context.checkpoint.manifest.epochId,
    "cross-epoch rollback requires a separate reviewed code/configuration restoration; no hidden reset is permitted");
  const targetBundle = await readCheckpointBundle(target, options.store);
  must(options.rollbackReview, "rollback requires a target-bound reviewed operation");
  const reviewFile = resolve(root, options.rollbackReview);
  const reviewBytes = await readFile(reviewFile);
  const review = json(reviewBytes, "rollback-review.json");
  const transition = validateRollbackReview(review, rollbackReviewBinding(context.checkpoint, target));
  return { ...context, target, targetBundle, targetCapability: options.rollbackCheckpoint,
    targetHash: trustedFingerprint(target), reviewFile, reviewBytes, transition };
}

async function recheckRollback(context, directory, manifest) {
  must(equal(candidateRuntimeBinding(), context.runtime), "runtime changed during accepted rollback");
  must(equal((await activeSnapshot(context.root)).inputs, context.active.inputs), "active configuration or accepted data changed during rollback");
  const receipt = await receiptBytesAt(context.root);
  must(receipt !== null && receipt.equals(context.activeReceipt), "accepted receipt changed during rollback");
  must(trustedFingerprint(await readVerifiedAcceptedCheckpoint(context.capability)) === context.trustedHash, "current rollback checkpoint changed");
  must(trustedFingerprint(await readVerifiedAcceptedCheckpoint(context.targetCapability)) === context.targetHash, "target rollback checkpoint changed");
  must((await readFile(context.reviewFile)).equals(context.reviewBytes), "rollback review changed during operation");
  if (directory) await assertBaselineUnchanged(context.root, directory, manifest);
}

function restoreArtifacts(context) {
  const { baseline, targetBundle } = context;
  const plan = rollbackSourcePlan(baseline.lifecycle, targetBundle.lifecycle, context.transition.review);
  const lifecycle = buildCandidateLifecycle({ baseline: { bundleId: baseline.manifest.bundleId, summary: baseline.summary, lifecycle: baseline.lifecycle },
    current: { summary: targetBundle.summary }, sourcePlan: plan });
  const kg = targetBundle.kg; const news = targetBundle.news;
  const provenance = json(targetBundle.files.get("provenance.json.gz"), "provenance.json.gz");
  const diff = { schemaVersion: "2.0.0", epistemicScope: "extraction_assignment",
    graph: diffKnowledgeGraphs(baseline.kg, kg), news: diffRecords(baseline.news, news, { collections: ["pages", "news"] }),
    ...actionAssessmentDiff(baseline.kg, kg),
    lifecycle: { baselineBundleId: baseline.manifest.bundleId, transitionsHash: hash(lifecycle.transitions),
      note: "Each assignment belongs to its own news projection. Withdrawn support never labels a real-world claim false." },
    restoration: { targetBundleId: targetBundle.manifest.bundleId, freshSourceReplay: false } };
  const recipe = clone(targetBundle.manifest.inputs.recipe);
  const inputs = { ...clone(context.snapshot.inputs), runtime: clone(context.runtime), recipe,
    sourceInventory: { sha256: hash(plan.observedInventory), fileCount: Object.keys(plan.observedInventory).length },
    effectiveInventory: { sha256: hash(plan.effectiveInventory), fileCount: Object.keys(plan.effectiveInventory).length },
    sourceReview: { sha256: sha256("null\n") }, baselineCandidate: { bundleId: baseline.manifest.bundleId, sha256: hash(baseline.manifest) },
    verification: candidateVerificationBinding(context.checkpoint, { rollbackTarget: context.target }), transition: context.transition };
  must(equal(semanticAxes(inputs, targetBundle.manifest.versions), semanticAxes(targetBundle.manifest.inputs, targetBundle.manifest.versions)), "rollback current axes differ from accepted target");
  return { inputs, versions: clone(targetBundle.manifest.versions), artifacts: {
    "kg.json": kg, "news.json": news, "provenance.json.gz": provenance, "lifecycle.json.gz": lifecycle, "source-review.json": null, "diff.json": diff,
  } };
}

function rollbackAcceptedFiles(context, manifest, artifacts) {
  const files = acceptedFiles(context, manifest, artifacts);
  // The target may use a different JSON whitespace encoding. Restore the exact
  // accepted bytes, while its canonical artifact remains independently bound.
  for (const path of REQUIRED_ACCEPTED_PATHS.slice(0, 2)) files.set(path, Buffer.from(context.target.files.get(path)));
  return files;
}
function rollbackResult(context) {
  return { ...resultContext(context), mode: "rollback", transition: context.transition, freshSourceReplay: false,
    rollbackTarget: { commit: context.target.commit, manifest: context.target.manifest } };
}

/** Restore trusted rendered outputs and derive forward identity history.
 * This is intentionally NOT a claim that raw upstream bytes were replayed. */
export async function buildAcceptedRollback(root, options = {}, hooks = {}) {
  checkOptions(options, hooks); root = resolve(root); const start = performance.now();
  const context = await rollbackContext(root, options, hooks);
  const restored = restoreArtifacts(context);
  const classification = classifyAcceptedRelease({ previous: releaseSnapshot(context.baseline.manifest, context.baseline.artifacts),
    current: { inputs: restored.inputs, kg: restored.artifacts["kg.json"], news: restored.artifacts["news.json"], lifecycle: restored.artifacts["lifecycle.json.gz"] } });
  await hooks.afterNewsRegeneration?.();
  await recheckRollback(context);
  if (!classification.hasChanges) {
    assertLifecycleArtifacts(restored.artifacts, restoreArtifacts(context).artifacts);
    await hooks.beforePublish?.(); await recheckRollback(context);
    return { noop: true, existing: true, output: null, manifest: context.baseline.manifest,
      artifacts: { ...context.baseline.artifacts, "provenance.json.gz": json(context.baseline.files.get("provenance.json.gz"), "provenance.json.gz") },
      acceptedFiles: new Map(context.checkpoint.files), classification, ...rollbackResult(context), metrics: metrics(start, restored.artifacts, context.baseline.manifest) };
  }
  const output = resolve(root, options.output ?? resolve(context.historyRoot, hash(restored.inputs).slice(0, 20)));
  must(dirname(output) === context.historyRoot && !basename(output).startsWith("."), "rollback output must be a direct non-hidden child of history-root");
  assertCandidateOutput(root, output, context.sourceRoot);
  const result = await publishCandidateBundle(output, { ...restored,
    validate: async ({ manifest, artifacts }) => {
      assertLifecycleBudget(manifest);
      must(equal(manifest.inputs, restored.inputs) && equal(manifest.versions, restored.versions), "rollback publication recipe mismatch");
      await recheckRollback(context);
      assertLifecycleArtifacts(artifacts, restoreArtifacts(context).artifacts);
      return [];
    },
  }, { beforePublish: async () => { await hooks.beforePublish?.(); await recheckRollback(context); } });
  return { ...result, output, noop: false, artifacts: restored.artifacts, acceptedFiles: rollbackAcceptedFiles(context, result.manifest, restored.artifacts),
    classification, ...rollbackResult(context), metrics: metrics(start, restored.artifacts, result.manifest) };
}

export async function verifyAcceptedRollback(root, directory, options = {}, hooks = {}) {
  checkOptions(options, hooks); root = resolve(root);
  const context = await rollbackContext(root, options, hooks);
  const target = resolve(root, directory); assertCandidateOutput(root, target, context.sourceRoot);
  const bundle = await verifyCandidateBundle(target); assertLifecycleBudget(bundle.manifest);
  const expected = restoreArtifacts(context);
  must(equal(bundle.manifest.inputs, expected.inputs) && equal(bundle.manifest.versions, expected.versions), "rollback target/review/checkpoint binding mismatch");
  assertLifecycleArtifacts(bundle.artifacts, expected.artifacts);
  await hooks.beforeVerifyReturn?.();
  await recheckRollback(context, target, bundle.manifest);
  return { manifest: bundle.manifest, artifacts: bundle.artifacts, acceptedFiles: rollbackAcceptedFiles(context, bundle.manifest, expected.artifacts),
    ...rollbackResult(context), historyBundles: 0, verificationVersion: ACCEPTED_VERIFICATION_VERSION };
}
