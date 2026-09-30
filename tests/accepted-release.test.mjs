import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { ALLOWED_ACCEPTED_PATHS, REQUIRED_ACCEPTED_PATHS, acceptedReleaseIdentity, classifyAcceptedRelease, createAcceptedArchiveState, createAcceptedRelease, validateAcceptedRelease, validateAcceptedReleaseFiles, validateAcceptedReleaseStructure } from "../scripts/lib/accepted-release.mjs";
import { validateRollbackReview } from "../scripts/lib/accepted-transition.mjs";

const hash = (value) => sha256(canonicalJson(value));
const bytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const pretty = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const binding = (value) => ({ sha256: sha256(value), bytes: value.length });
const clone = (value) => JSON.parse(canonicalJson(value));
const codeCommit = "a".repeat(40);
const sourceCommit = "b".repeat(40);
const originalCommit = "c".repeat(40);
const acceptedCommit = "d".repeat(40);
const path = "daily/a.md";
const source = { name: "bedtimenews/bedtimenews-archive-contents", url: "https://github.com/bedtimenews/bedtimenews-archive-contents", submodulePath: "sources/bedtimenews-archive-contents" };
const originalBindings = Object.fromEntries(["acceptedKG", "acceptedNews", "acceptedState"].map((name, index) => [name, { path: REQUIRED_ACCEPTED_PATHS[index], sha256: sha256(`original ${name}`) }]));
const origin = { commit: originalCommit, bindings: originalBindings };
const generatedAt = "2026-01-01T00:00:00Z";
const versionLabels = { candidate: "2.0.0", lifecycle: "1.0.0", ontology: "2.3.0", extraction: "4.1.0", news: "1.1.0", segmentation: "1.4.0", overrides: "1.1.0", compiler: "1.0.0", node: "22.13.0", icu: "76.1" };
const compiler = { formatVersion: 1, compilerVersion: "1.0.0", sourceHash: sha256("ontology"), patternsHash: sha256("patterns") };
const runtime = { node: versionLabels.node, icu: versionLabels.icu, v8: "12.4.254.21-node.22", unicode: "16.0", locale: "en-US", timeZone: "UTC" };
const runtimeBinding = { ...runtime, sha256: hash(runtime) };
const configs = Object.fromEntries(Object.entries({ ontologySource: "data/ontology-source.json", ontology: "data/ontology.json", patterns: "data/extraction-patterns.json", rules: "data/extraction-rules.json", newsOverrides: "data/news-overrides.json", compiler: "scripts/lib/ontology-compiler.mjs", segmentation: "scripts/lib/news.mjs" }).map(([name, path]) => [name, { path, sha256: sha256(name) }]));
const generatorFiles = { "scripts/lib/kg-build.mjs": sha256("generator") };
const reference = (manifest, commit = acceptedCommit) => ({ commit, releaseId: manifest.releaseId, bundleId: manifest.candidateBundleId });

function rehashCandidate(manifest) {
  const payload = { ...manifest }; delete payload.bundleId;
  manifest.bundleId = hash(payload);
}
function receiptFor(manifest, selectedCodeCommit = codeCommit) {
  const repository = "fixture/audit"; const tag = `kg-audit-${manifest.bundleId}`;
  const files = { ...manifest.artifacts, "manifest.json": binding(bytes(manifest)) };
  return { schemaVersion: 2, kind: "github-audit-readback", repository, bundleId: manifest.bundleId,
    manifestSha256: files["manifest.json"].sha256, targetCommit: selectedCodeCommit, tag, releaseId: 7,
    releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`, githubImmutableAtReadback: false, visibilityAtReadback: "draft", readbackVerified: true,
    assets: Object.fromEntries(Object.entries(files).map(([name, descriptor], index) => {
      const assetName = `${descriptor.sha256}-${name}`;
      return [name, { ...descriptor, id: index + 10, name: assetName, url: `https://github.com/${repository}/releases/download/${tag}/${assetName}` }];
    })), rawSourceArchiveIncluded: false,
    sourceReplay: "Restoring accepted outputs does not guarantee raw upstream re-extraction; upstream Git history must be available separately." };
}
function fixture({ previous = null, previousCommit = acceptedCommit, inventory = { [path]: sha256("source a") }, sourceStates = {}, kgChange = {}, recipeChange = {}, originChange, configChange = {} } = {}) {
  const currentOrigin = originChange ?? origin;
  const effective = Object.fromEntries(Object.entries(inventory).filter(([name]) => !Object.hasOwn(sourceStates, name)));
  const kg = { schemaVersion: versionLabels.ontology, generatedAt,
    source: { ...source, newsDatasetSchemaVersion: versionLabels.news, extractionVersion: versionLabels.extraction, segmentationVersion: versionLabels.segmentation, newsOverrideVersion: versionLabels.overrides, ontologyCompilation: compiler },
    entities: [{ id: "entity-a", label: "A" }], events: [], eventRelations: [], entityRelations: [], sources: [], ...kgChange };
  const news = { schemaVersion: versionLabels.news, generatedAt, source, segmentation: { version: versionLabels.segmentation, overrideVersion: versionLabels.overrides }, pages: [], news: [] };
  const lifecycle = { schemaVersion: 1, epistemicScope: "extraction_assignment", parentBundleId: previous?.candidateBundleId ?? null,
    observedInventory: clone(inventory), effectiveInventory: effective, sourceStates: clone(sourceStates), decisions: [], states: { entities: [], news: [], assertions: [] }, transitions: { entities: [], news: [], assertions: [] } };
  const recipe = { includedRoots: ["daily"], archiveCommit: sourceCommit, generatedAt, storageBudget: { maxLedgerCompressedBytes: 67108864, maxTotalArtifactBytes: 134217728 }, ...recipeChange };
  const inputs = { ...clone(configs), ...clone(currentOrigin.bindings), generator: { files: generatorFiles, sha256: hash(generatorFiles) }, runtime: runtimeBinding,
    recipe: { ...recipe, sha256: hash(recipe) }, sourceInventory: { sha256: hash(inventory), fileCount: Object.keys(inventory).length },
    effectiveInventory: { sha256: hash(effective), fileCount: Object.keys(effective).length }, sourceReview: { sha256: sha256("null\n") }, ...clone(configChange) };
  if (previous) inputs.baselineCandidate = { bundleId: previous.candidateBundleId, sha256: previous.candidateManifestHash };
  const artifacts = { "kg.json": kg, "news.json": news, "lifecycle.json.gz": lifecycle, "provenance.json.gz": {}, "source-review.json": null, "diff.json": {} };
  const candidateManifest = { schemaVersion: 1, kind: "offline-candidate", versions: versionLabels, inputs,
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, binding(name.endsWith(".gz") ? gzipSync(bytes(value), { level: 6 }) : bytes(value))])) };
  rehashCandidate(candidateManifest);
  const previousState = { schemaVersion: 3, source, includedRoots: ["daily"], initialImportCommit: originalCommit, ontologyCompilation: compiler };
  const state = createAcceptedArchiveState({ previousState, candidateManifest, lifecycle, sourceCommit: recipe.archiveCommit });
  const acceptedFiles = { [REQUIRED_ACCEPTED_PATHS[0]]: pretty(kg), [REQUIRED_ACCEPTED_PATHS[1]]: pretty(news), [REQUIRED_ACCEPTED_PATHS[2]]: pretty(state) };
  const options = { candidateManifest, lifecycle, acceptedFiles, origin: currentOrigin, predecessor: previous ? reference(previous, previousCommit) : null,
    codeCommit, sourceCommit: recipe.archiveCommit, auditReceipt: receiptFor(candidateManifest), mode: previous ? "continuation" : "bootstrap",
    verifiedPredecessor: previous ? { commit: previousCommit, manifest: previous } : null, auditRepository: "fixture/audit" };
  return { options, kg, news, lifecycle, state, snapshot: { kg, news, lifecycle, inputs }, refresh() { rehashCandidate(candidateManifest); options.auditReceipt = receiptFor(candidateManifest, options.codeCommit); } };
}
function replaceState(f, edit) {
  edit(f.state); f.options.acceptedFiles[REQUIRED_ACCEPTED_PATHS[2]] = pretty(f.state);
}
function replaceKg(f, edit) {
  edit(f.kg); f.options.acceptedFiles[REQUIRED_ACCEPTED_PATHS[0]] = pretty(f.kg);
  f.options.candidateManifest.artifacts["kg.json"] = binding(bytes(f.kg)); f.refresh();
}

test("accepted manifest is deterministic, binds exact pretty output bytes and separates immutable origin", () => {
  const f = fixture(); const before = clone(f.options.candidateManifest);
  const release = createAcceptedRelease(f.options);
  assert.deepEqual(release, createAcceptedRelease(f.options));
  assert.deepEqual(f.options.candidateManifest, before);
  assert.equal(release.schemaVersion, 1); assert.equal(release.mode, "bootstrap");
  assert.equal(release.source.durableRawSource, false);
  assert.equal(release.candidateManifestHash, hash(f.options.candidateManifest));
  assert.deepEqual(release.origin, origin); assert.equal(release.predecessor, null);
  assert.equal(release.acceptedFiles[REQUIRED_ACCEPTED_PATHS[0]].sha256, sha256(f.options.acceptedFiles[REQUIRED_ACCEPTED_PATHS[0]]));
  assert.notEqual(release.acceptedFiles[REQUIRED_ACCEPTED_PATHS[0]].sha256, f.options.candidateManifest.artifacts["kg.json"].sha256);
  assert.equal(Object.hasOwn(release, "commit"), false);
  assert.deepEqual(validateAcceptedRelease(release, f.options), []);
  assert.deepEqual(createAcceptedRelease({ ...f.options, acceptedFiles: new Map(Object.entries(f.options.acceptedFiles).reverse()) }), release);
});

test("release identity is independent of remote asset and release IDs", () => {
  const f = fixture(); const first = createAcceptedRelease(f.options);
  f.options.auditReceipt.releaseId = 888;
  for (const asset of Object.values(f.options.auditReceipt.assets)) asset.id += 1000;
  f.options.auditReceipt.githubImmutableAtReadback = true;
  const again = createAcceptedRelease(f.options);
  assert.equal(first.releaseId, again.releaseId);
  assert.notDeepEqual(first.auditReceipt, again.auditReceipt);
});

test("three required paths and reviewed reports are the only permitted byte targets", () => {
  const f = fixture();
  for (const path of ALLOWED_ACCEPTED_PATHS.slice(3)) f.options.acceptedFiles[path] = pretty({ report: path });
  assert.equal(Object.keys(createAcceptedRelease(f.options).acceptedFiles).length, 6);
  for (const path of ["data/accepted-release.json", "data/raw/source.md", "../.github/workflows/x.yml", "/tmp/credentials.json", "data/generated/../kg.json", "DATA/generated/kg.json"]) {
    assert.throws(() => createAcceptedRelease({ ...f.options, acceptedFiles: { ...f.options.acceptedFiles, [path]: "{}" } }), /unreviewed accepted output path/u);
  }
  for (const path of REQUIRED_ACCEPTED_PATHS) {
    const files = { ...f.options.acceptedFiles }; delete files[path];
    assert.throws(() => createAcceptedRelease({ ...f.options, acceptedFiles: files }), /required accepted outputs/u);
  }
  assert.throws(() => createAcceptedRelease({ ...f.options, acceptedFiles: { ...f.options.acceptedFiles, [REQUIRED_ACCEPTED_PATHS[0]]: Buffer.from([0xff]) } }), /invalid JSON/u);
});

test("mixed candidate, exact output bytes, source commit, origin, config and runtime bindings fail closed", () => {
  const cases = [
    [(f) => { f.options.sourceCommit = "f".repeat(40); }, /source commit mismatch/u],
    [(f) => { f.options.origin = { ...origin, bindings: { ...origin.bindings, acceptedKG: { ...origin.bindings.acceptedKG, sha256: sha256("other") } } }; }, /immutable origin mismatch/u],
    [(f) => { f.options.acceptedFiles[REQUIRED_ACCEPTED_PATHS[0]] = pretty({ ...f.kg, entities: [] }); }, /differs from the candidate/u],
    [(f) => { f.options.candidateManifest.bundleId = sha256("fake"); }, /bundle identity mismatch/u],
    [(f) => { f.options.candidateManifest.inputs.runtime = { ...runtimeBinding, timeZone: "elsewhere" }; f.refresh(); }, /runtime hash mismatch/u],
    [(f) => { f.options.candidateManifest.inputs.generator = { ...f.options.candidateManifest.inputs.generator, sha256: sha256("other") }; f.refresh(); }, /generator hash mismatch/u],
    [(f) => { f.options.candidateManifest.inputs.sourceInventory.sha256 = sha256("other"); f.refresh(); }, /observed source inventory binding mismatch/u],
    [(f) => { f.options.candidateManifest.inputs.effectiveInventory.fileCount = 2; f.refresh(); }, /effective source inventory binding mismatch/u],
    [(f) => { f.lifecycle.states.entities.push({ id: "forged" }); }, /lifecycle artifact byte binding mismatch/u],
  ];
  for (const [edit, pattern] of cases) { const f = fixture(); edit(f); assert.throws(() => createAcceptedRelease(f.options), pattern); }
});

test("state schema 4 uses effective sources and separate observed/tombstone hashes", () => {
  const inventory = { [path]: sha256("a"), "daily/withdrawn.md": sha256("withdrawn") };
  const sourceStates = { "daily/withdrawn.md": { status: "retracted", lastHash: inventory["daily/withdrawn.md"], reviewedAt: generatedAt, reason: "reviewed exclusion" }, "daily/deleted.md": { status: "deleted", lastHash: sha256("deleted"), reviewedAt: generatedAt, reason: "reviewed deletion" } };
  const f = fixture({ inventory, sourceStates }); const release = createAcceptedRelease(f.options);
  assert.deepEqual(f.state.acceptedFiles, { [path]: inventory[path] });
  assert.equal(f.state.observedFilesHash, hash(inventory)); assert.equal(f.state.sourceStatesHash, hash(sourceStates));
  assert.equal(Object.hasOwn(f.state, "sourceStates"), false);
  assert.equal(release.inventories.observed.fileCount, 2); assert.equal(release.inventories.effective.fileCount, 1);
  replaceState(f, (state) => { state.acceptedFiles = inventory; });
  assert.throws(() => createAcceptedRelease(f.options), /effective inventory only/u);
});

test("KG, news, state and compilation version labels must agree exactly", () => {
  for (const key of ["ontologyVersion", "extractionVersion", "segmentationVersion", "newsOverrideVersion", "newsDatasetSchemaVersion"]) {
    const f = fixture(); replaceState(f, (state) => { state[key] = "99.0.0"; });
    assert.throws(() => createAcceptedRelease(f.options), /archive-state .* mismatch/u);
  }
  for (const edit of [
    (state) => { state.schemaVersion = 3; }, (state) => { state.materialization = "append-only"; },
    (state) => { state.observedFilesHash = sha256("wrong"); }, (state) => { state.sourceStatesHash = sha256("wrong"); },
    (state) => { state.lastObservedCommit = originalCommit; }, (state) => { state.lastObservedAt = "2026-01-02T00:00:00Z"; },
    (state) => { state.releaseId = sha256("circular"); }, (state) => { state.sourceStates = {}; },
    (state) => { state.ontologyCompilation.compilerVersion = "99.0.0"; },
  ]) { const f = fixture(); replaceState(f, edit); assert.throws(() => createAcceptedRelease(f.options), /archive-state|compiler metadata/u); }
  const f = fixture(); replaceKg(f, (kg) => { kg.source.extractionVersion = "99.0.0"; });
  assert.throws(() => createAcceptedRelease(f.options), /KG source extractionVersion mismatch/u);
});

test("audit read-back must bind every exact candidate artifact, manifest, repository and code tag", () => {
  const mutations = [
    (r) => { r.readbackVerified = false; }, (r) => { r.repository = "wrong/repo"; },
    (r) => { r.manifestSha256 = sha256("wrong"); }, (r) => { r.targetCommit = originalCommit; },
    (r) => { r.tag = "mutable-latest"; }, (r) => { r.rawSourceArchiveIncluded = true; },
    (r) => { delete r.assets["provenance.json.gz"]; }, (r) => { r.assets["kg.json"].sha256 = sha256("wrong"); },
    (r) => { r.assets["kg.json"].bytes += 1; }, (r) => { r.assets["kg.json"].url = "https://attacker.invalid/file"; },
    (r) => { r.assets["upstream-raw.json"] = r.assets["kg.json"]; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f.options.auditReceipt); assert.throws(() => createAcceptedRelease(f.options), /audit|read-back/u); }
});

test("continuation needs explicit verified Git checkpoint matching predecessor and immutable epoch", () => {
  const seed = createAcceptedRelease(fixture().options); const next = fixture({ previous: seed, kgChange: { extraMetadata: "global changes" } });
  const release = createAcceptedRelease(next.options);
  assert.deepEqual(release.origin, seed.origin); assert.deepEqual(release.predecessor, reference(seed));
  assert.equal(release.mode, "continuation"); assert.equal(release.epochId, seed.epochId);
  assert.throws(() => createAcceptedRelease({ ...next.options, verifiedPredecessor: null }), /externally verified Git checkpoint/u);
  assert.throws(() => createAcceptedRelease({ ...next.options, verifiedPredecessor: { commit: originalCommit, manifest: seed } }), /does not match verified Git/u);
  assert.throws(() => createAcceptedRelease({ ...next.options, predecessor: { ...reference(seed), releaseId: sha256("fake") } }), /does not match verified Git/u);
  const wrong = fixture({ previous: seed, configChange: { rules: { ...configs.rules, sha256: sha256("new semantic rules") } } });
  assert.throws(() => createAcceptedRelease(wrong.options), /different semantic\/runtime epoch/u);
  next.options.candidateManifest.inputs.baselineCandidate.sha256 = sha256("fake"); next.refresh();
  assert.throws(() => createAcceptedRelease(next.options), /predecessor mismatch/u);
  assert.throws(() => createAcceptedRelease({ ...fixture().options, predecessor: reference(seed) }), /bootstrap cannot inherit/u);
});

test("structural hash checking never supplies missing checkpoint trust", () => {
  const seed = createAcceptedRelease(fixture().options);
  // It is possible to rehash a local object. That does not make it an accepted
  // checkpoint: callers still must fetch the exact Git commit before supplying it.
  const forged = clone(seed); forged.codeCommit = "e".repeat(40); forged.auditReceipt.targetCommit = forged.codeCommit; forged.releaseId = acceptedReleaseIdentity(forged);
  assert.equal(validateAcceptedReleaseStructure(forged), forged);
  const f = fixture({ previous: forged });
  assert.throws(() => createAcceptedRelease({ ...f.options, verifiedPredecessor: null }), /externally verified Git checkpoint/u);
  assert.notDeepEqual(validateAcceptedRelease(forged, fixture().options), []);
});

test("rollback is a forward release to an explicitly verified same-epoch accepted target", () => {
  const targetFixture = fixture(); const target = createAcceptedRelease(targetFixture.options);
  const latest = createAcceptedRelease(fixture({ previous: target, kgChange: { entities: [{ id: "entity-a", label: "Revised" }] } }).options);
  const f = fixture({ previous: latest, previousCommit: "e".repeat(40) });
  const binding = { schemaVersion: 1, kind: "accepted-rollback", baseline: { releaseId: latest.releaseId, bundleId: latest.candidateBundleId }, target: reference(target) };
  const transition = validateRollbackReview({ ...binding, reviewedAt: generatedAt, reason: "Restore the exact reviewed target" }, binding);
  f.options.candidateManifest.inputs.transition = transition; f.refresh();
  const options = { ...f.options, mode: "rollback", transition, rollbackTarget: reference(target), verifiedRollbackTarget: { commit: acceptedCommit, manifest: target } };
  const rollback = createAcceptedRelease(options);
  assert.equal(rollback.predecessor.releaseId, latest.releaseId); assert.equal(rollback.rollbackTarget.releaseId, target.releaseId);
  assert.notEqual(rollback.releaseId, target.releaseId);
  assert.deepEqual(rollback.acceptedFiles[REQUIRED_ACCEPTED_PATHS[0]], target.acceptedFiles[REQUIRED_ACCEPTED_PATHS[0]]);
  assert.equal(rollback.source.durableRawSource, false);
  assert.throws(() => createAcceptedRelease({ ...options, verifiedRollbackTarget: null }), /externally verified Git checkpoint/u);
  assert.throws(() => createAcceptedRelease({ ...options, rollbackTarget: reference(latest) }), /does not match verified Git/u);
  const wrong = fixture({ previous: latest, previousCommit: "e".repeat(40), kgChange: { entities: [] } });
  assert.throws(() => createAcceptedRelease({ ...wrong.options, mode: "rollback", rollbackTarget: reference(target), verifiedRollbackTarget: { commit: acceptedCommit, manifest: target } }), /restore exact accepted target bytes/u);
  const canonicalOutput = { ...options, acceptedFiles: { ...options.acceptedFiles, [REQUIRED_ACCEPTED_PATHS[0]]: bytes(f.kg) } };
  assert.throws(() => createAcceptedRelease(canonicalOutput), /restore exact accepted target bytes/u);
});

test("rollback rejects incompatible epochs and wrong target source even with matching output graphs", () => {
  const target = createAcceptedRelease(fixture().options);
  const other = createAcceptedRelease(fixture({ configChange: { patterns: { ...configs.patterns, sha256: sha256("other epoch") } } }).options);
  const f = fixture({ previous: target });
  assert.throws(() => createAcceptedRelease({ ...f.options, mode: "rollback", rollbackTarget: reference(other), verifiedRollbackTarget: { commit: acceptedCommit, manifest: other } }), /different semantic\/runtime epoch/u);
  const wrongSource = fixture({ previous: target, recipeChange: { archiveCommit: "f".repeat(40) } });
  assert.throws(() => createAcceptedRelease({ ...wrongSource.options, mode: "rollback", rollbackTarget: reference(target), verifiedRollbackTarget: { commit: acceptedCommit, manifest: target } }), /target pinned source/u);
});

test("no-op classification ignores moved baseline, source commit and top-level generation timestamps", () => {
  const initial = fixture(); const current = fixture();
  current.snapshot.kg.generatedAt = "2026-06-01T00:00:00Z";
  current.snapshot.news.generatedAt = "2026-06-01T00:00:00Z";
  current.snapshot.inputs.recipe.archiveCommit = "f".repeat(40); current.snapshot.inputs.recipe.generatedAt = "2026-06-01T00:00:00Z";
  current.snapshot.inputs.baselineCandidate = { bundleId: sha256("new baseline"), sha256: sha256("new manifest") };
  current.snapshot.inputs.acceptedKG = { ...originalBindings.acceptedKG, sha256: sha256("new accepted baseline") };
  current.snapshot.lifecycle.parentBundleId = sha256("new parent"); current.snapshot.lifecycle.states = { entities: [{ id: "identity", recordRef: { bundleId: "self", recordId: "identity" } }] };
  assert.equal(classifyAcceptedRelease({ previous: initial.snapshot, current: current.snapshot }).classification, "noop");
  assert.equal(classifyAcceptedRelease({ current: current.snapshot }).classification, "bootstrap");
});

test("no-op classification compares every graph/news field, observed/effective inventory, tombstone and semantic config", () => {
  const mutations = [
    [(f) => { f.kg.entities[0].label = "different"; }, "kg"],
    [(f) => { f.kg.otherMetadata = { qualifier: "new" }; }, "kg"],
    [(f) => { f.kg.entities[0].generatedAt = "nested semantic date"; }, "kg"],
    [(f) => { f.news.pages.push({ id: "excluded-page", contentHash: sha256("different") }); }, "news"],
    [(f) => { f.lifecycle.observedInventory["daily/unpublished.md"] = sha256("observed only"); }, "observedInventory"],
    [(f) => { f.lifecycle.effectiveInventory[path] = sha256("effective different"); }, "effectiveInventory"],
    [(f) => { f.lifecycle.sourceStates[path] = { status: "deleted", lastHash: sha256("a"), reviewedAt: generatedAt, reason: "decision" }; }, "sourceStates"],
    [(f) => { f.snapshot.inputs.ontologySource.sha256 = sha256("configuration change"); }, "configuration"],
  ];
  for (const [edit, field] of mutations) {
    const before = fixture(); const current = fixture(); edit(current);
    const result = classifyAcceptedRelease({ previous: before.snapshot, current: current.snapshot });
    assert.equal(result.classification, "changed"); assert.ok(result.changed.includes(field));
  }
  const before = fixture({ sourceStates: { "daily/gone.md": { status: "deleted", lastHash: sha256("gone"), reviewedAt: generatedAt, reason: "withdrawal" } } });
  const current = clone(before.snapshot); current.lifecycle.sourceStates["daily/gone.md"].reviewedAt = "2026-02-01T00:00:00Z";
  assert.deepEqual(classifyAcceptedRelease({ previous: before.snapshot, current }).changed, ["sourceStates"]);
});


test("rendered checkpoint restoration verifies exact bytes without upstream source availability", () => {
  const f = fixture(); const release = createAcceptedRelease(f.options);
  const parsed = validateAcceptedReleaseFiles(release, f.options.acceptedFiles);
  assert.deepEqual(parsed[REQUIRED_ACCEPTED_PATHS[0]], f.kg);
  const files = { ...f.options.acceptedFiles, [REQUIRED_ACCEPTED_PATHS[0]]: bytes(f.kg) };
  assert.throws(() => validateAcceptedReleaseFiles(release, files), /output bytes differ/u);
  assert.equal(release.source.durableRawSource, false);
});

test("unknown receipt fields, duplicated asset IDs, false raw-source claims and self-references are rejected", () => {
  for (const mutate of [
    (r) => { r.credential = "must never enter public manifest"; },
    (r) => { r.assets["kg.json"].rawSource = "must never enter public manifest"; },
    (r) => { r.assets["kg.json"].id = r.assets["news.json"].id; },
    (r) => { r.sourceReplay = "All raw source bytes are durable"; },
  ]) {
    const f = fixture(); mutate(f.options.auditReceipt);
    assert.throws(() => createAcceptedRelease(f.options), /audit|read-back/u);
  }
  const f = fixture(); const release = createAcceptedRelease(f.options);
  release.commit = "f".repeat(40); release.releaseId = acceptedReleaseIdentity(release);
  assert.throws(() => validateAcceptedReleaseStructure(release), /unknown accepted manifest fields/u);
});

test("lifecycle maps cannot smuggle withdrawn bytes into the effective inventory", () => {
  const f = fixture();
  f.lifecycle.sourceStates[path] = { status: "retracted", lastHash: f.lifecycle.observedInventory[path], reviewedAt: generatedAt, reason: "withdrawn" };
  f.options.candidateManifest.artifacts["lifecycle.json.gz"] = binding(gzipSync(bytes(f.lifecycle), { level: 6 })); f.refresh();
  assert.throws(() => createAcceptedRelease(f.options), /effective inventory differs/u);
});

test("new acceptance requires durable draft read-back and keeps its historical visibility receipt", () => {
  const f = fixture();
  const release = createAcceptedRelease(f.options);
  assert.equal(release.auditReceipt.schemaVersion, 2);
  assert.equal(release.auditReceipt.visibilityAtReadback, "draft");
  assert.doesNotThrow(() => validateAcceptedReleaseStructure(release));
  f.options.auditReceipt.visibilityAtReadback = "published";
  assert.throws(() => createAcceptedRelease(f.options), /draft audit staging/u);
  f.options.auditReceipt.visibilityAtReadback = "draft";
  f.options.auditReceipt.schemaVersion = 1;
  assert.throws(() => createAcceptedRelease(f.options), /audit read-back receipt/u);
});

test("legacy accepted receipts remain byte-stable while optional identity registry is bound exactly", () => {
  const legacy = createAcceptedRelease(fixture().options);
  assert.equal(Object.hasOwn(legacy.configuration, "identityRegistry"), false);
  assert.deepEqual(validateAcceptedReleaseStructure(legacy), legacy);
  const identityRegistry = { path: "data/entity-identities.json", sha256: sha256("reviewed identity registry") };
  const next = createAcceptedRelease(fixture({ configChange: { identityRegistry } }).options);
  assert.deepEqual(next.configuration.identityRegistry, identityRegistry);
  assert.notEqual(next.epochId, legacy.epochId);
  assert.throws(() => createAcceptedRelease(fixture({ configChange: { identityRegistry: { ...identityRegistry, path: "data/unbound-identities.json" } } }).options), /configuration path/u);
  assert.throws(() => createAcceptedRelease(fixture({ configChange: { identityRegistry: { ...identityRegistry, sha256: "unknown" } } }).options), /configuration binding/u);
  const continuation = fixture({ previous: legacy, configChange: { identityRegistry } });
  assert.throws(() => createAcceptedRelease(continuation.options), /migration|epoch/u);
});
