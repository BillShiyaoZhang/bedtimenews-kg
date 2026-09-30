import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { isSourceReviewTimestamp } from "./candidate-source-review.mjs";

const hash = (value) => sha256(canonicalJson(value));
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const clone = (value) => JSON.parse(canonicalJson(value));
const must = (value, message) => { if (!value) throw new Error(`Accepted transition: ${message}`); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, names) => object(value) && equal(Object.keys(value).sort(), [...names].sort());
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
export const SEMANTIC_CONFIGURATION_NAMES = Object.freeze(["ontologySource", "ontology", "patterns", "rules", "newsOverrides", "compiler", "segmentation", "generator"]);

// Deliberately production-only. D still binds its original complete generator
// snapshot. These are the code paths that produce/validate semantic records;
// transport, scheduling, CLI wrappers, docs and tests are pinned by codeCommit,
// but editing them does not change the semantic epoch.
export const ACCEPTED_SEMANTIC_GENERATOR_FILES = Object.freeze([
  "app/lib/ontology-hierarchy.mjs", "app/lib/topic-evidence.mjs",
  "scripts/lib/accepted-candidate.mjs", "scripts/lib/accepted-release.mjs", "scripts/lib/accepted-reports.mjs", "scripts/lib/accepted-transition.mjs",
  "scripts/lib/candidate-bundle.mjs", "scripts/lib/candidate-lifecycle.mjs", "scripts/lib/candidate-provenance.mjs",
  "scripts/lib/candidate-run.mjs", "scripts/lib/candidate-source-review.mjs", "scripts/lib/extraction-rules.mjs",
  "scripts/lib/extraction.mjs", "scripts/lib/git-object-integrity.mjs", "scripts/lib/kg-build.mjs",
  "scripts/lib/lifecycle-run.mjs", "scripts/lib/news-build.mjs", "scripts/lib/news.mjs",
  "scripts/lib/ontology-compiler.mjs", "scripts/lib/source-snapshot.mjs", "scripts/lib/topic-evidence.mjs", "scripts/lib/validate.mjs",
].sort());

export function acceptedSemanticSnapshot(snapshot) {
  const files = Object.fromEntries(ACCEPTED_SEMANTIC_GENERATOR_FILES.map((path) => {
    const value = snapshot.inputs.generator.files[path];
    must(HASH.test(value ?? ""), `missing semantic generator binding: ${path}`);
    return [path, value];
  }));
  return { ...snapshot, inputs: { ...snapshot.inputs, generator: { files, sha256: hash(files) } } };
}

export function semanticAxes(inputs, versions) {
  const configuration = Object.fromEntries(SEMANTIC_CONFIGURATION_NAMES.map((name) => {
    must(object(inputs?.[name]) && HASH.test(inputs[name].sha256 ?? ""), `missing semantic axis: ${name}`);
    return [name, clone(inputs[name])];
  }));
  must(object(inputs.runtime) && HASH.test(inputs.runtime.sha256 ?? "") && object(versions), "missing runtime/version axes");
  return { configuration, runtime: clone(inputs.runtime), versions: clone(versions) };
}

export function acceptedBaselineReference(checkpoint) {
  const manifest = checkpoint?.manifest;
  must(manifest && HASH.test(manifest.releaseId ?? "") && HASH.test(manifest.candidateBundleId ?? ""), "accepted predecessor is required");
  return { releaseId: manifest.releaseId, bundleId: manifest.candidateBundleId };
}

export function migrationReviewBinding({ checkpoint, previous, inputs, versions, diff }) {
  must(previous?.manifest && object(diff), "migration requires a previous accepted bundle and reviewed diff");
  const from = semanticAxes(previous.manifest.inputs, previous.manifest.versions);
  const to = semanticAxes(inputs, versions);
  return { schemaVersion: 1, kind: "semantic-migration", baseline: acceptedBaselineReference(checkpoint),
    from, to, fromHash: hash(from), toHash: hash(to), diffHash: sha256(`${canonicalJson(diff)}\n`),
    archiveCommit: inputs.recipe.archiveCommit, observedInventoryHash: inputs.sourceInventory.sha256,
    sourceReviewHash: inputs.sourceReview.sha256 };
}

export function validateMigrationReview(review, expected) {
  must(exact(review, [...Object.keys(expected), "reviewedAt", "reason"]), "migration review has missing or unknown fields");
  const { reviewedAt, reason, ...binding } = review;
  must(equal(binding, expected), "migration review does not match the exact predecessor, old/new axes, source inputs and diff");
  must(expected.schemaVersion === 1 && expected.kind === "semantic-migration" && expected.fromHash === hash(expected.from) && expected.toHash === hash(expected.to) &&
    HASH.test(expected.diffHash ?? "") && COMMIT.test(expected.archiveCommit ?? "") && HASH.test(expected.observedInventoryHash ?? "") && HASH.test(expected.sourceReviewHash ?? ""), "invalid migration semantic/source binding");
  must(expected.fromHash !== expected.toHash, "migration review is unused; semantic/runtime axes did not change");
  must(isSourceReviewTimestamp(reviewedAt) && typeof reason === "string" && reason.trim(), "migration review requires a valid time and reason");
  return { kind: "reviewed-semantic-migration", review: clone(review), sha256: hash(review) };
}

export function validateMigrationTransition(transition, { previous, current, diffHash }) {
  must(exact(transition, ["kind", "review", "sha256"]) && transition.kind === "reviewed-semantic-migration" && transition.sha256 === hash(transition.review), "invalid reviewed migration binding");
  const review = transition.review;
  const from = { configuration: previous.configuration, runtime: previous.runtime, versions: previous.versions };
  const to = { configuration: current.configuration, runtime: current.runtime, versions: current.versions };
  const expected = { schemaVersion: 1, kind: "semantic-migration", baseline: { releaseId: previous.releaseId, bundleId: previous.candidateBundleId },
    from, to, fromHash: hash(from), toHash: hash(to), diffHash,
    archiveCommit: current.source.commit, observedInventoryHash: current.inventories.observed.sha256,
    sourceReviewHash: review.sourceReviewHash };
  return validateMigrationReview(review, expected);
}

/** A semantic review cannot stand in for not-yet-implemented split/merge ID
 * mapping. Existing effective pages must keep their ordered news identities. */
export function assertMigrationNewsContinuity(previous, current) {
  const ordered = (dataset, path) => {
    const page = dataset.pages.find((row) => row.repositoryPath === path);
    return dataset.news.filter((row) => row.pageId === page?.id).sort((a, b) => a.fragment.ordinal - b.fragment.ordinal).map((row) => row.id);
  };
  for (const path of Object.keys(previous.lifecycle.effectiveInventory)) {
    if (!Object.hasOwn(current.lifecycle.effectiveInventory, path)) continue;
    must(equal(ordered(previous.news, path), ordered(current.news, path)), `news-boundary identity mapping not implemented: ${path}`);
  }
}

export function rollbackReviewBinding(checkpoint, target) {
  must(COMMIT.test(target?.commit ?? "") && target?.manifest, "rollback requires an accepted ancestor checkpoint");
  return { schemaVersion: 1, kind: "accepted-rollback", baseline: acceptedBaselineReference(checkpoint),
    target: { commit: target.commit, ...acceptedBaselineReference(target) } };
}

export function validateRollbackReview(review, expected) {
  must(exact(review, [...Object.keys(expected), "reviewedAt", "reason"]), "rollback review has missing or unknown fields");
  const { reviewedAt, reason, ...binding } = review;
  must(equal(binding, expected), "rollback review does not match the exact current release and accepted ancestor target");
  must(isSourceReviewTimestamp(reviewedAt) && typeof reason === "string" && reason.trim(), "rollback review requires a valid time and reason");
  must(expected.baseline.releaseId !== expected.target.releaseId, "rollback target is already the accepted release");
  return { kind: "trusted-accepted-output-restore", review: clone(review), sha256: hash(review), freshSourceReplay: false };
}

/** Keep every later withdrawal unless this explicit target restores its path.
 * Sources introduced after the target become tombstones, never forgotten IDs. */
export function rollbackSourcePlan(current, target, review) {
  const observedInventory = clone(target.observedInventory);
  const effectiveInventory = clone(target.effectiveInventory);
  const sourceStates = clone(target.sourceStates);
  for (const [path, state] of Object.entries(current.sourceStates)) {
    if (!Object.hasOwn(observedInventory, path)) sourceStates[path] = clone(state);
  }
  for (const [path, lastHash] of Object.entries(current.observedInventory)) {
    if (!Object.hasOwn(observedInventory, path) && !Object.hasOwn(sourceStates, path)) {
      sourceStates[path] = { status: "deleted", lastHash, reviewedAt: review.reviewedAt, reason: `Accepted rollback: ${review.reason}` };
    }
  }
  return { observedInventory, effectiveInventory, sourceStates, decisions: [] };
}
