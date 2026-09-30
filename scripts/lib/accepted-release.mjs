import { gzipSync } from "node:zlib";
import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { isSourceReviewTimestamp, validateCandidateSourceInventory, planCandidateSourceReview } from "./candidate-source-review.mjs";
import { validateMigrationTransition, validateMigrationReview, validateRollbackReview } from "./accepted-transition.mjs";

// This module is deliberately pure. Hash consistency is NOT proof of acceptance.
// Only a caller that read the exact accepted Git commit may supply a verified
// checkpoint. Never upgrade an arbitrary local receipt into that trusted input.
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const CONFIG_PATHS = { ontologySource: "data/ontology-source.json", ontology: "data/ontology.json", patterns: "data/extraction-patterns.json", rules: "data/extraction-rules.json", newsOverrides: "data/news-overrides.json", compiler: "scripts/lib/ontology-compiler.mjs", segmentation: "scripts/lib/news.mjs" };
const CONFIG_NAMES = [...Object.keys(CONFIG_PATHS), "generator"];
const OPTIONAL_CONFIG_PATHS = { identityRegistry: "data/entity-identities.json" };
const SOURCE_REPLAY_NOTICE = "Restoring accepted outputs does not guarantee raw upstream re-extraction; upstream Git history must be available separately.";
const ORIGIN_NAMES = ["acceptedState", "acceptedKG", "acceptedNews"];
const ARTIFACTS = ["diff.json", "kg.json", "lifecycle.json.gz", "news.json", "provenance.json.gz", "source-review.json"];
export const REQUIRED_ACCEPTED_PATHS = Object.freeze(["data/generated/kg.json", "data/processed/news.json", "data/archive-state.json"]);
export const ALLOWED_ACCEPTED_PATHS = Object.freeze([...REQUIRED_ACCEPTED_PATHS,
  "data/review/upstream-changes.json", "data/review/news-segmentation.json", "data/review/ontology-candidates.json"]);
const ORIGIN_PATHS = { acceptedState: REQUIRED_ACCEPTED_PATHS[2], acceptedKG: REQUIRED_ACCEPTED_PATHS[0], acceptedNews: REQUIRED_ACCEPTED_PATHS[1] };
const must = (value, message) => { if (!value) throw new Error(`Accepted release: ${message}`); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const clone = (value) => JSON.parse(canonicalJson(value));
const hash = (value) => sha256(canonicalJson(value));
const exact = (value, names) => object(value) && equal(Object.keys(value).sort(), [...names].sort());
const binding = (value) => exact(value, ["sha256", "bytes"]) && HASH.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0;
const fileBinding = (bytes) => ({ sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) });
const inventoryBinding = (inventory) => ({ sha256: hash(inventory), fileCount: Object.keys(inventory).length });
const jsonBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

function parse(bytes, name) {
  must(Buffer.isBuffer(bytes) || typeof bytes === "string", `${name} must contain exact bytes`);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))); }
  catch (error) { throw new Error(`Accepted release: invalid JSON in ${name}`, { cause: error }); }
}
function roots(value) {
  must(Array.isArray(value) && value.length && new Set(value).size === value.length && value.every((root) => typeof root === "string" && /^[a-z][a-z0-9_-]*$/u.test(root)), "invalid included roots");
  return [...value].sort();
}
function source(value) {
  must(exact(value, ["name", "url", "submodulePath"]) && typeof value.name === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.name), "invalid source repository");
  must(value.url === `https://github.com/${value.name}` && value.submodulePath === "sources/bedtimenews-archive-contents", "source must be a pinned repository URL and the reviewed gitlink path");
  return clone(value);
}
function versions(value) {
  const names = ["candidate", "lifecycle", "ontology", "extraction", "news", "segmentation", "overrides", "compiler", "node", "icu"];
  must(exact(value, names) && Object.values(value).every((entry) => typeof entry === "string" && entry.trim()), "missing or unknown version labels");
  return clone(value);
}
function origin(value) {
  must(exact(value, ["commit", "bindings"]) && COMMIT.test(value.commit ?? "") && exact(value.bindings, ORIGIN_NAMES), "origin must bind the original accepted Git commit and three outputs");
  for (const name of ORIGIN_NAMES) must(exact(value.bindings[name], ["path", "sha256"]) && value.bindings[name].path === ORIGIN_PATHS[name] && HASH.test(value.bindings[name].sha256 ?? ""), `invalid origin binding ${name}`);
  return clone(value);
}
function reference(value, label) {
  must(exact(value, ["commit", "releaseId", "bundleId"]) && COMMIT.test(value.commit ?? "") && HASH.test(value.releaseId ?? "") && HASH.test(value.bundleId ?? ""), `invalid ${label} reference`);
  return clone(value);
}
function configuration(inputs) {
  must(object(inputs), "missing candidate inputs");
  const result = {};
  for (const name of [...CONFIG_NAMES, ...Object.keys(OPTIONAL_CONFIG_PATHS).filter((key) => Object.hasOwn(inputs, key))]) {
    must(object(inputs[name]) && HASH.test(inputs[name].sha256 ?? ""), `missing configuration binding ${name}`);
    // Public receipts carry hashes/paths, not copies of source text or secrets.
    result[name] = { sha256: inputs[name].sha256 };
    if (name !== "generator") {
      must(inputs[name].path === (CONFIG_PATHS[name] ?? OPTIONAL_CONFIG_PATHS[name]), `invalid configuration path ${name}`);
      result[name].path = inputs[name].path;
    } else {
      must(object(inputs.generator.files) && Object.keys(inputs.generator.files).length && Object.entries(inputs.generator.files).every(([path, value]) => /^(?:scripts|app\/lib)\/[a-zA-Z0-9_/-]+\.mjs$/u.test(path) && HASH.test(value)), "invalid generator file bindings");
      must(hash(inputs.generator.files) === inputs.generator.sha256, "generator hash mismatch");
      result[name].files = clone(inputs.generator.files);
    }
  }
  return result;
}
function runtime(value, versionLabels) {
  must(exact(value, ["node", "icu", "unicode", "v8", "locale", "timeZone", "sha256"]) && Object.values(value).every((entry) => typeof entry === "string" && entry.length), "invalid runtime binding");
  must(HASH.test(value.sha256) && hash(without(value, ["sha256"])) === value.sha256, "runtime hash mismatch");
  must(value.node === versionLabels.node && value.icu === versionLabels.icu, "runtime version mismatch");
  return clone(value);
}
function candidate(value) {
  must(exact(value, ["schemaVersion", "kind", "bundleId", "artifacts", "inputs", "versions"]) && value.schemaVersion === 1 && value.kind === "offline-candidate", "invalid candidate manifest");
  must(HASH.test(value.bundleId ?? "") && hash(without(value, ["bundleId"])) === value.bundleId, "candidate bundle identity mismatch");
  must(exact(value.artifacts, ARTIFACTS) && Object.values(value.artifacts).every(binding), "candidate must bind the complete reviewed lifecycle bundle");
  const labels = versions(value.versions);
  configuration(value.inputs); runtime(value.inputs.runtime, labels);
  const recipe = value.inputs.recipe;
  must(object(recipe) && COMMIT.test(recipe.archiveCommit ?? "") && HASH.test(recipe.sha256 ?? "") && hash(without(recipe, ["sha256"])) === recipe.sha256, "invalid source recipe");
  roots(recipe.includedRoots);
  must(isSourceReviewTimestamp(recipe.generatedAt), "invalid pinned recipe time");
  return value;
}
function lifecycleFor(value, manifest) {
  must(object(value) && value.schemaVersion === 1 && value.epistemicScope === "extraction_assignment", "invalid lifecycle");
  must(value.parentBundleId === null || HASH.test(value.parentBundleId ?? ""), "invalid lifecycle parent");
  const scope = roots(manifest.inputs.recipe.includedRoots);
  validateCandidateSourceInventory(value.observedInventory, scope);
  validateCandidateSourceInventory(value.effectiveInventory, scope);
  // A no-change source-review pass validates tombstones and the exact relation
  // observed - withdrawn = effective, including persistent deletion metadata.
  planCandidateSourceReview({ baselineBundleId: value.parentBundleId,
    baselineObservedInventory: value.observedInventory, baselineEffectiveInventory: value.effectiveInventory,
    baselineSourceStates: value.sourceStates, currentInventory: value.observedInventory, includedRoots: scope });
  must(equal(manifest.inputs.sourceInventory, inventoryBinding(value.observedInventory)), "observed source inventory binding mismatch");
  must(equal(manifest.inputs.effectiveInventory, inventoryBinding(value.effectiveInventory)), "effective source inventory binding mismatch");
  must(equal(manifest.artifacts["lifecycle.json.gz"], fileBinding(gzipSync(jsonBytes(value), { level: 6 }))), "lifecycle artifact byte binding mismatch");
  return value;
}
function outputs(files) {
  must(object(files) || files instanceof Map, "acceptedFiles must be a path-to-byte map");
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  must(entries.length && new Set(entries.map(([path]) => path)).size === entries.length, "duplicate accepted output path");
  const parsed = {}; const bindings = {};
  for (const [path, bytes] of entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    must(ALLOWED_ACCEPTED_PATHS.includes(path), `unreviewed accepted output path: ${String(path)}`);
    parsed[path] = parse(bytes, path); bindings[path] = fileBinding(bytes);
  }
  must(REQUIRED_ACCEPTED_PATHS.every((path) => Object.hasOwn(bindings, path)), "three required accepted outputs are missing");
  return { parsed, bindings };
}
function assertMaterialization(parsed, manifest, lifecycle, sourceCommit) {
  const [kgPath, newsPath, statePath] = REQUIRED_ACCEPTED_PATHS;
  const kg = parsed[kgPath]; const news = parsed[newsPath]; const state = parsed[statePath];
  must(object(kg) && object(news) && object(state), "accepted datasets must be JSON objects");
  for (const [name, value] of [["kg.json", kg], ["news.json", news]]) must(equal(fileBinding(jsonBytes(value)), manifest.artifacts[name]), `${name} differs from the candidate materialization`);
  const v = manifest.versions;
  must(kg.schemaVersion === v.ontology && news.schemaVersion === v.news && news.segmentation?.version === v.segmentation && news.segmentation?.overrideVersion === v.overrides, "KG/news version mismatch");
  for (const [field, name] of Object.entries({ ontologyVersion: "ontology", extractionVersion: "extraction", segmentationVersion: "segmentation", newsOverrideVersion: "overrides", newsDatasetSchemaVersion: "news" })) {
    must(state[field] === v[name], `archive-state ${field} mismatch`);
    if (field !== "ontologyVersion") must(kg.source?.[field] === v[name], `KG source ${field} mismatch`);
  }
  must(state.ontologyCompilation?.compilerVersion === v.compiler && equal(state.ontologyCompilation, kg.source?.ontologyCompilation), "compiler metadata mismatch");
  must(state.schemaVersion === 4 && state.materialization === "full-candidate", "archive-state must use full-candidate schema 4");
  must(equal(state.acceptedFiles, lifecycle.effectiveInventory), "archive-state acceptedFiles must mean effective inventory only");
  must(state.observedFilesHash === hash(lifecycle.observedInventory) && state.sourceStatesHash === hash(lifecycle.sourceStates), "archive-state observed/tombstone hash mismatch");
  must(!Object.hasOwn(state, "releaseId") && !Object.hasOwn(state, "observedInventory") && !Object.hasOwn(state, "sourceStates"), "archive-state must not duplicate lifecycle maps or embed a circular release ID");
  must(state.lastObservedCommit === sourceCommit && state.lastObservedAt === manifest.inputs.recipe.generatedAt, "archive-state source checkpoint mismatch");
  must(equal(roots(state.includedRoots), roots(manifest.inputs.recipe.includedRoots)), "archive-state source scope mismatch");
  source(state.source);
  must(kg.source?.url === state.source.url && news.source?.url === state.source.url, "source repository mismatch");
}

/** Build state v4 without a release ID/self-hash cycle. acceptedFiles is effective only. */
export function createAcceptedArchiveState({ previousState, candidateManifest, lifecycle, sourceCommit, ontologyCompilation = previousState?.ontologyCompilation }) {
  candidate(candidateManifest); lifecycleFor(lifecycle, candidateManifest);
  must(object(previousState) && [3, 4].includes(previousState.schemaVersion), "unsupported previous archive state");
  must(sourceCommit === candidateManifest.inputs.recipe.archiveCommit, "sourceCommit differs from candidate recipe");
  const v = candidateManifest.versions;
  const state = { ...clone(previousState), schemaVersion: 4, materialization: "full-candidate",
    ontologyCompilation: clone(ontologyCompilation),
    ontologyVersion: v.ontology, extractionVersion: v.extraction, segmentationVersion: v.segmentation,
    newsOverrideVersion: v.overrides, newsDatasetSchemaVersion: v.news,
    lastObservedCommit: sourceCommit, lastObservedAt: candidateManifest.inputs.recipe.generatedAt,
    acceptedFiles: clone(lifecycle.effectiveInventory), observedFilesHash: hash(lifecycle.observedInventory), sourceStatesHash: hash(lifecycle.sourceStates) };
  for (const key of ["releaseId", "observedInventory", "sourceStates"]) delete state[key];
  return state;
}

function auditStructure(receipt, { bundleId, codeCommit, expectedRepository } = {}) {
  must(exact(receipt, ["schemaVersion", "kind", "repository", "bundleId", "manifestSha256", "targetCommit", "tag", "releaseId", "releaseUrl", "githubImmutableAtReadback", "visibilityAtReadback", "readbackVerified", "assets", "rawSourceArchiveIncluded", "sourceReplay"]) && receipt.schemaVersion === 2 && receipt.kind === "github-audit-readback" && receipt.readbackVerified === true, "verified audit read-back receipt required");
  must(typeof receipt.repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(receipt.repository) && (!expectedRepository || receipt.repository === expectedRepository), "audit repository mismatch");
  must(HASH.test(receipt.bundleId ?? "") && HASH.test(receipt.manifestSha256 ?? "") && receipt.bundleId === bundleId, "audit candidate mismatch");
  must(receipt.targetCommit === codeCommit && receipt.tag === `kg-audit-${bundleId}`, "audit tag/code target mismatch");
  must(Number.isSafeInteger(receipt.releaseId) && receipt.releaseId > 0 && receipt.releaseUrl === `https://github.com/${receipt.repository}/releases/tag/${receipt.tag}`, "invalid audit release reference");
  must(typeof receipt.githubImmutableAtReadback === "boolean" && ["draft", "published"].includes(receipt.visibilityAtReadback) && receipt.rawSourceArchiveIncluded === false && receipt.sourceReplay === SOURCE_REPLAY_NOTICE, "audit must state the raw-source replay limitation");
  must(exact(receipt.assets, [...ARTIFACTS, "manifest.json"]), "audit receipt has missing or unreviewed assets");
  const ids = new Set();
  for (const [name, asset] of Object.entries(receipt.assets)) {
    must(exact(asset, ["id", "name", "bytes", "sha256", "url"]) && Number.isSafeInteger(asset.id) && asset.id > 0 && !ids.has(asset.id) && binding({ sha256: asset.sha256, bytes: asset.bytes }), `invalid audit asset: ${name}`);
    ids.add(asset.id);
    must(asset.name === `${asset.sha256}-${name}` && asset.url === `https://github.com/${receipt.repository}/releases/download/${receipt.tag}/${asset.name}`, `invalid audit asset destination: ${name}`);
  }
  must(receipt.assets["manifest.json"].sha256 === receipt.manifestSha256, "audit manifest asset mismatch");
}
function audit(receipt, manifest, codeCommit, expectedRepository) {
  auditStructure(receipt, { bundleId: manifest.bundleId, codeCommit, expectedRepository });
  must(receipt.manifestSha256 === sha256(jsonBytes(manifest)), "audit manifest hash mismatch");
  const expected = { ...manifest.artifacts, "manifest.json": fileBinding(jsonBytes(manifest)) };
  for (const [name, expectedBinding] of Object.entries(expected)) {
    const asset = receipt.assets[name];
    must(equal({ sha256: asset.sha256, bytes: asset.bytes }, expectedBinding), `audit asset bytes mismatch: ${name}`);
  }
  return clone(receipt);
}
function epoch(value) {
  return hash({ origin: value.origin, versions: value.versions, configuration: value.configuration, runtime: value.runtime, sourceRepository: value.source.repository, includedRoots: value.source.includedRoots });
}
/** The identity excludes transport IDs/URLs and receipt claims; candidate bindings already bind audit bytes. */
export function acceptedReleaseIdentity(manifest) { return hash(without(manifest, ["releaseId", "auditReceipt"])); }

/**
 * Structural/hash validation ONLY. It does not establish that any Git commit,
 * upload, review, or semantic replay occurred. The Git runner owns that trust.
 */
export function validateAcceptedReleaseStructure(manifest) {
  must(exact(manifest, ["schemaVersion", "kind", "releaseId", "mode", "transition", "epochId", "origin", "predecessor", "rollbackTarget", "candidateBundleId", "candidateManifestHash", "codeCommit", "versions", "configuration", "runtime", "source", "inventories", "acceptedFiles", "auditReceipt"]), "missing or unknown accepted manifest fields");
  must(manifest.schemaVersion === 1 && manifest.kind === "accepted-release" && ["bootstrap", "continuation", "migration", "rollback"].includes(manifest.mode), "invalid accepted manifest schema/mode");
  origin(manifest.origin); versions(manifest.versions);
  must(equal(configuration(manifest.configuration), manifest.configuration), "invalid configuration payload");
  runtime(manifest.runtime, manifest.versions);
  must(exact(manifest.source, ["repository", "commit", "includedRoots", "durableRawSource"]) && COMMIT.test(manifest.source.commit ?? "") && manifest.source.durableRawSource === false, "invalid pinned source contract");
  source(manifest.source.repository); roots(manifest.source.includedRoots);
  must(COMMIT.test(manifest.codeCommit ?? "") && HASH.test(manifest.candidateBundleId ?? "") && HASH.test(manifest.candidateManifestHash ?? ""), "invalid code/candidate binding");
  must(exact(manifest.inventories, ["observed", "effective", "sourceStatesHash"]), "invalid inventory bindings");
  for (const name of ["observed", "effective"]) must(exact(manifest.inventories[name], ["sha256", "fileCount"]) && HASH.test(manifest.inventories[name].sha256 ?? "") && Number.isSafeInteger(manifest.inventories[name].fileCount) && manifest.inventories[name].fileCount >= 0, `invalid ${name} inventory binding`);
  must(HASH.test(manifest.inventories.sourceStatesHash ?? ""), "invalid source states binding");
  must(object(manifest.acceptedFiles) && REQUIRED_ACCEPTED_PATHS.every((path) => Object.hasOwn(manifest.acceptedFiles, path)) && Object.entries(manifest.acceptedFiles).every(([path, value]) => ALLOWED_ACCEPTED_PATHS.includes(path) && binding(value)), "invalid accepted output bindings");
  if (manifest.mode === "bootstrap") must(manifest.predecessor === null && manifest.rollbackTarget === null, "bootstrap cannot have predecessor/rollback target");
  else reference(manifest.predecessor, "predecessor");
  if (manifest.mode === "rollback") reference(manifest.rollbackTarget, "rollback target");
  else must(manifest.rollbackTarget === null, "only rollback may name a target");
  if (manifest.mode === "migration") {
    const transition = manifest.transition;
    must(exact(transition, ["kind", "review", "sha256"]) && transition.kind === "reviewed-semantic-migration" && transition.sha256 === hash(transition.review), "invalid migration transition");
    const expected = without(transition.review, ["reviewedAt", "reason"]);
    validateMigrationReview(transition.review, expected);
    must(equal(transition.review.baseline, { releaseId: manifest.predecessor.releaseId, bundleId: manifest.predecessor.bundleId }) &&
      equal(transition.review.to, { configuration: manifest.configuration, runtime: manifest.runtime, versions: manifest.versions }), "migration transition differs from accepted axes");
  } else if (manifest.mode === "rollback") {
    must(equal(manifest.transition, validateRollbackReview(manifest.transition?.review, {
      schemaVersion: 1, kind: "accepted-rollback", baseline: { releaseId: manifest.predecessor.releaseId, bundleId: manifest.predecessor.bundleId }, target: manifest.rollbackTarget,
    })), "invalid rollback transition");
  } else must(manifest.transition === null, "only migration/rollback may bind a transition review");
  must(manifest.epochId === epoch(manifest), "semantic epoch mismatch");
  must(HASH.test(manifest.releaseId ?? "") && manifest.releaseId === acceptedReleaseIdentity(manifest), "accepted release identity mismatch");
  auditStructure(manifest.auditReceipt, { bundleId: manifest.candidateBundleId, codeCommit: manifest.codeCommit });
  return manifest;
}
/**
 * Check saved rendered outputs without consulting upstream Git or re-extracting.
 * The manifest must come from the caller's verified accepted Git checkpoint;
 * this helper proves byte consistency, not the provenance of that checkpoint.
 */
export function validateAcceptedReleaseFiles(manifest, acceptedFiles) {
  validateAcceptedReleaseStructure(manifest);
  const { parsed, bindings } = outputs(acceptedFiles);
  must(equal(bindings, manifest.acceptedFiles), "accepted output bytes differ from the checkpoint");
  return parsed;
}

function checkpoint(value, expected, label) {
  must(exact(value, ["commit", "manifest"]), `${label} requires an explicit externally verified Git checkpoint`);
  validateAcceptedReleaseStructure(value.manifest);
  must(equal(reference(expected, label), { commit: value.commit, releaseId: value.manifest.releaseId, bundleId: value.manifest.candidateBundleId }), `${label} does not match verified Git checkpoint`);
  return value.manifest;
}

/**
 * Assemble a release after candidate replay and audit read-back. verifiedPredecessor
 * and verifiedRollbackTarget are inputs from the Git authority boundary, NOT
 * flags or hashes supplied by an untrusted local candidate directory.
 */
export function createAcceptedRelease({ candidateManifest, lifecycle, acceptedFiles, origin: suppliedOrigin, predecessor = null, codeCommit, sourceCommit, auditReceipt,
  mode = "continuation", transition = null, rollbackTarget = null, verifiedPredecessor = null, verifiedRollbackTarget = null, auditRepository }) {
  candidate(candidateManifest); lifecycleFor(lifecycle, candidateManifest);
  must(auditReceipt?.visibilityAtReadback === "draft", "new acceptance requires draft audit staging before public publication");
  must(["bootstrap", "continuation", "migration", "rollback"].includes(mode), "unknown acceptance mode");
  must(COMMIT.test(codeCommit ?? "") && sourceCommit === candidateManifest.inputs.recipe.archiveCommit, "code/source commit mismatch");
  const initial = origin(suppliedOrigin);
  for (const name of ORIGIN_NAMES) must(equal(candidateManifest.inputs[name], initial.bindings[name]), `candidate immutable origin mismatch: ${name}`);
  const { parsed, bindings } = outputs(acceptedFiles);
  assertMaterialization(parsed, candidateManifest, lifecycle, sourceCommit);
  const state = parsed[REQUIRED_ACCEPTED_PATHS[2]];
  const manifest = { schemaVersion: 1, kind: "accepted-release", mode, transition: clone(transition), origin: initial,
    predecessor: predecessor === null ? null : reference(predecessor, "predecessor"),
    rollbackTarget: rollbackTarget === null ? null : reference(rollbackTarget, "rollback target"),
    candidateBundleId: candidateManifest.bundleId, candidateManifestHash: hash(candidateManifest), codeCommit,
    versions: versions(candidateManifest.versions), configuration: configuration(candidateManifest.inputs), runtime: runtime(candidateManifest.inputs.runtime, candidateManifest.versions),
    source: { repository: source(state.source), commit: sourceCommit, includedRoots: roots(state.includedRoots), durableRawSource: false },
    inventories: { observed: inventoryBinding(lifecycle.observedInventory), effective: inventoryBinding(lifecycle.effectiveInventory), sourceStatesHash: hash(lifecycle.sourceStates) },
    acceptedFiles: bindings, auditReceipt: audit(auditReceipt, candidateManifest, codeCommit, auditRepository) };
  manifest.epochId = epoch(manifest);
  if (mode === "bootstrap") {
    must(predecessor === null && verifiedPredecessor === null && rollbackTarget === null && verifiedRollbackTarget === null && lifecycle.parentBundleId === null && !candidateManifest.inputs.baselineCandidate, "bootstrap cannot inherit a checkpoint");
  } else {
    const previous = checkpoint(verifiedPredecessor, predecessor, "predecessor");
    must(equal(previous.origin, manifest.origin) && equal(previous.source.repository, manifest.source.repository) && equal(previous.source.includedRoots, manifest.source.includedRoots), "release transition cannot change origin or source scope");
    if (mode === "migration") {
      must(previous.epochId !== manifest.epochId, "migration review is unused; semantic/runtime epoch did not change");
      validateMigrationTransition(transition, { previous, current: manifest, diffHash: candidateManifest.artifacts["diff.json"].sha256 });
      must(transition.review.sourceReviewHash === candidateManifest.inputs.sourceReview.sha256 && equal(candidateManifest.inputs.transition, transition), "candidate migration review binding mismatch");
    } else must(previous.epochId === manifest.epochId, "predecessor is from a different semantic/runtime epoch; reviewed migration required");
    must(lifecycle.parentBundleId === predecessor.bundleId && candidateManifest.inputs.baselineCandidate?.bundleId === predecessor.bundleId && candidateManifest.inputs.baselineCandidate?.sha256 === previous.candidateManifestHash, "candidate/lifecycle predecessor mismatch");
  }
  if (mode === "rollback") {
    const target = checkpoint(verifiedRollbackTarget, rollbackTarget, "rollback target");
    must(target.epochId === manifest.epochId, "rollback target is from a different semantic/runtime epoch");
    must(equal(target.source, manifest.source) && equal(target.inventories.effective, manifest.inventories.effective), "rollback must restore the target pinned source and effective inventory");
    for (const path of REQUIRED_ACCEPTED_PATHS.slice(0, 2)) must(equal(target.acceptedFiles[path], bindings[path]), `rollback must restore exact accepted target bytes: ${path}`);
    const reviewed = validateRollbackReview(transition?.review, { schemaVersion: 1, kind: "accepted-rollback", baseline: { releaseId: predecessor.releaseId, bundleId: predecessor.bundleId }, target: rollbackTarget });
    must(equal(transition, reviewed) && equal(candidateManifest.inputs.transition, transition), "candidate rollback review binding mismatch");
  } else must(rollbackTarget === null && verifiedRollbackTarget === null, "only rollback may restore a target");
  if (!["migration", "rollback"].includes(mode)) must(transition === null && !candidateManifest.inputs.transition, "unused release transition review");
  manifest.releaseId = acceptedReleaseIdentity(manifest);
  validateAcceptedReleaseStructure(manifest);
  return clone(manifest);
}

/** Compare to a deterministic reconstruction; still no independent Git trust. */
export function validateAcceptedRelease(manifest, options) {
  try { validateAcceptedReleaseStructure(manifest); must(equal(manifest, createAcceptedRelease(options)), "stored manifest differs from accepted payload"); return []; }
  catch (error) { return [{ level: "error", path: "accepted-release", message: error.message }]; }
}

function semanticSnapshot(value) {
  must(object(value) && object(value.kg) && object(value.news) && object(value.lifecycle), "no-op classification requires full graph, news and lifecycle snapshots");
  const inputs = value.inputs ?? value.candidateManifest?.inputs;
  const config = configuration(inputs);
  const runtimeBinding = inputs.runtime;
  must(object(runtimeBinding) && HASH.test(runtimeBinding.sha256 ?? ""), "no-op classification requires runtime bindings");
  return {
    kg: without(value.kg, ["generatedAt"]), news: without(value.news, ["generatedAt"]),
    observedInventory: value.lifecycle.observedInventory, effectiveInventory: value.lifecycle.effectiveInventory, sourceStates: value.lifecycle.sourceStates,
    configuration: config, runtime: runtimeBinding, includedRoots: roots(inputs.recipe.includedRoots),
  };
}

/** Parent IDs, recipe time/commit and accepted-baseline movement never create a version alone. */
export function classifyAcceptedRelease({ previous = null, current }) {
  const next = semanticSnapshot(current);
  if (previous === null) return { classification: "bootstrap", hasChanges: true, changed: Object.keys(next), previousHash: null, currentHash: hash(next) };
  const before = semanticSnapshot(previous);
  const changed = Object.keys(next).filter((key) => !equal(before[key], next[key]));
  return { classification: changed.length ? "changed" : "noop", hasChanges: Boolean(changed.length), changed, previousHash: hash(before), currentHash: hash(next) };
}
