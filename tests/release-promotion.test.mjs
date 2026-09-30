import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { createAcceptedArchiveState, createAcceptedRelease, acceptedReleaseIdentity, REQUIRED_ACCEPTED_PATHS } from "../scripts/lib/accepted-release.mjs";
import { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint } from "../scripts/lib/accepted-git.mjs";
import { prepareAcceptedCommit, promoteAcceptedCommit, reconcileAcceptedCommit, recoverPreparedAcceptedCommit, inspectReviewedMigrationProposal, prepareReviewedMigrationCommit } from "../scripts/lib/release-promotion.mjs";
import { candidateVerificationBinding, candidateProposalBinding } from "../scripts/lib/accepted-candidate.mjs";
import { rollbackReviewBinding, validateRollbackReview, migrationReviewBinding, validateMigrationReview } from "../scripts/lib/accepted-transition.mjs";

const execFile = promisify(execFileCallback);
const repository = "fixture/accepted";
const sourcePath = "sources/bedtimenews-archive-contents";
const source = { name: "bedtimenews/bedtimenews-archive-contents", url: "https://github.com/bedtimenews/bedtimenews-archive-contents", submodulePath: sourcePath };
const jsonBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const hash = (value) => sha256(canonicalJson(value));
const clone = (value) => JSON.parse(canonicalJson(value));
const binding = (value) => ({ sha256: sha256(value), bytes: value.length });
const generatedAt = "2026-01-03T00:00:00Z";
const versions = { candidate: "3.0.0", lifecycle: "1.0.0", ontology: "2.3.0", extraction: "4.1.0", news: "1.1.0", segmentation: "1.4.0", overrides: "1.1.0", compiler: "1.0.0", node: "22.13.0", icu: "76.1" };
const compiler = { formatVersion: 1, compilerVersion: "1.0.0", sourceHash: sha256("ontology"), patternsHash: sha256("patterns") };
const configPaths = { ontologySource: "data/ontology-source.json", ontology: "data/ontology.json", patterns: "data/extraction-patterns.json", rules: "data/extraction-rules.json", newsOverrides: "data/news-overrides.json", compiler: "scripts/lib/ontology-compiler.mjs", segmentation: "scripts/lib/news.mjs" };
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
async function git(root, args) { return (await execFile("git", ["-C", root, ...args], { env: cleanEnv(), maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
async function put(root, path, content) { await mkdir(resolve(root, path, ".."), { recursive: true }); await writeFile(resolve(root, path), content); }
async function commit(root) {
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}
function receiptFor(manifest, codeCommit) {
  const tag = `kg-audit-${manifest.bundleId}`; const files = { ...manifest.artifacts, "manifest.json": binding(jsonBytes(manifest)) };
  return { schemaVersion: 2, kind: "github-audit-readback", repository, bundleId: manifest.bundleId, manifestSha256: files["manifest.json"].sha256,
    targetCommit: codeCommit, tag, releaseId: 7, releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
    githubImmutableAtReadback: false, visibilityAtReadback: "draft", readbackVerified: true,
    assets: Object.fromEntries(Object.entries(files).map(([name, value], index) => [name, { ...value, id: index + 10, name: `${value.sha256}-${name}`, url: `https://github.com/${repository}/releases/download/${tag}/${value.sha256}-${name}` }])),
    rawSourceArchiveIncluded: false, sourceReplay: "Restoring accepted outputs does not guarantee raw upstream re-extraction; upstream Git history must be available separately." };
}
async function proposal(root, capability, sourceCommit, change = "new", migrationCodeCommit = null) {
  const checkpoint = await readVerifiedAcceptedCheckpoint(capability);
  const configs = {};
  for (const [name, path] of Object.entries(configPaths)) configs[name] = { path, sha256: sha256(await readFile(resolve(root, path))) };
  const generatorFiles = { "scripts/lib/kg-build.mjs": sha256(await readFile(resolve(root, "scripts/lib/kg-build.mjs"))) };
  const runtime = { node: versions.node, icu: versions.icu, v8: "12.4.254.21-node.22", unicode: "16.0", locale: "en-US", timeZone: "UTC" };
  const kg = { schemaVersion: versions.ontology, generatedAt, source: { ...source, newsDatasetSchemaVersion: versions.news, extractionVersion: versions.extraction, segmentationVersion: versions.segmentation, newsOverrideVersion: versions.overrides, ontologyCompilation: compiler }, entities: [{ id: change }], events: [], eventRelations: [], entityRelations: [], sources: [] };
  const news = { schemaVersion: versions.news, generatedAt, source, segmentation: { version: versions.segmentation, overrideVersion: versions.overrides }, pages: [], news: [] };
  const inventory = { "daily/a.md": sha256(`source ${change}`) };
  const lifecycle = { schemaVersion: 1, epistemicScope: "extraction_assignment", parentBundleId: checkpoint.manifest?.candidateBundleId ?? null,
    observedInventory: inventory, effectiveInventory: inventory, sourceStates: {}, decisions: [], states: { entities: [], news: [], assertions: [] }, transitions: { entities: [], news: [], assertions: [] } };
  const recipe = { includedRoots: ["daily"], archiveCommit: sourceCommit, generatedAt, storageBudget: { maxLedgerCompressedBytes: 67108864, maxTotalArtifactBytes: 134217728 } };
  const verification = { version: "1.0.0", kind: "trusted-git-checkpoint-full-current-replay", originCommit: checkpoint.origin.commit,
    checkpoint: checkpoint.manifest ? { commit: checkpoint.commit, releaseId: checkpoint.manifest.releaseId, bundleId: checkpoint.manifest.candidateBundleId, manifestHash: hash(checkpoint.manifest) } : null };
  const inputs = { ...configs, ...checkpoint.origin.bindings, generator: { files: generatorFiles, sha256: hash(generatorFiles) }, runtime: { ...runtime, sha256: hash(runtime) },
    verification: { ...verification, sha256: hash(verification) }, recipe: { ...recipe, sha256: hash(recipe) },
    sourceInventory: { sha256: hash(inventory), fileCount: 1 }, effectiveInventory: { sha256: hash(inventory), fileCount: 1 }, sourceReview: { sha256: sha256("null\n") } };
  if (checkpoint.manifest) inputs.baselineCandidate = { bundleId: checkpoint.manifest.candidateBundleId, sha256: checkpoint.manifest.candidateManifestHash };
  const artifacts = { "kg.json": kg, "news.json": news, "lifecycle.json.gz": lifecycle, "provenance.json.gz": {}, "source-review.json": null, "diff.json": {} };
  const candidateManifest = { schemaVersion: 1, kind: "offline-candidate", versions, inputs, artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, binding(name.endsWith(".gz") ? gzipSync(jsonBytes(value), { level: 6 }) : jsonBytes(value))])) };
  let transition = null;
  if (migrationCodeCommit) {
    const expected = migrationReviewBinding({ checkpoint, previous: { manifest: { inputs: { ...checkpoint.manifest.configuration, runtime: checkpoint.manifest.runtime }, versions: checkpoint.manifest.versions } }, inputs, versions, diff: artifacts["diff.json"] });
    transition = validateMigrationReview({ ...expected, reviewedAt: generatedAt, reason: "Reviewed fixture generator migration" }, expected);
    candidateManifest.inputs.transition = transition;
    candidateManifest.inputs.reviewProposal = candidateProposalBinding(migrationCodeCommit);
  }
  candidateManifest.bundleId = hash(candidateManifest);
  const state = createAcceptedArchiveState({ previousState: JSON.parse(checkpoint.files.get(REQUIRED_ACCEPTED_PATHS[2])), candidateManifest, lifecycle, sourceCommit });
  const acceptedFiles = new Map([[REQUIRED_ACCEPTED_PATHS[0], jsonBytes(kg)], [REQUIRED_ACCEPTED_PATHS[1], jsonBytes(news)], [REQUIRED_ACCEPTED_PATHS[2], jsonBytes(state)]]);
  const releaseOptions = { candidateManifest, lifecycle, acceptedFiles, origin: { commit: checkpoint.origin.commit, bindings: checkpoint.origin.bindings },
    predecessor: checkpoint.manifest ? { commit: checkpoint.commit, releaseId: checkpoint.manifest.releaseId, bundleId: checkpoint.manifest.candidateBundleId } : null,
    codeCommit: migrationCodeCommit ?? checkpoint.commit, sourceCommit, auditReceipt: receiptFor(candidateManifest, migrationCodeCommit ?? checkpoint.commit), mode: migrationCodeCommit ? "migration" : checkpoint.manifest ? "continuation" : "bootstrap", transition,
    verifiedPredecessor: checkpoint.manifest ? { commit: checkpoint.commit, manifest: checkpoint.manifest } : null, auditRepository: repository };
  return { root, checkpoint: capability, candidateManifest, lifecycle, acceptedFiles, manifest: createAcceptedRelease(releaseOptions) };
}
async function fixture(callback) {
  const directory = await mkdtemp(resolve(tmpdir(), "release-promotion-")); const root = resolve(directory, "repo"); const archive = resolve(directory, "archive");
  try {
    await mkdir(root); await mkdir(archive); await git(archive, ["init", "-q"]); await put(archive, "a.md", "old source"); const oldSource = await commit(archive);
    await put(archive, "a.md", "new source"); const sourceCommit = await commit(archive);
    await git(root, ["init", "-q", "-b", "main"]); await git(root, ["remote", "add", "origin", `https://github.com/${repository}.git`]);
    for (const path of Object.values(configPaths)) await put(root, path, `${path}\n`);
    await put(root, "scripts/lib/kg-build.mjs", "export const generator = 1;\n");
    await put(root, "README.md", "preserve this exact existing file\n"); await put(root, "keep.txt", "base bytes\n");
    await put(root, REQUIRED_ACCEPTED_PATHS[0], jsonBytes({ legacy: "kg" })); await put(root, REQUIRED_ACCEPTED_PATHS[1], jsonBytes({ legacy: "news" }));
    await put(root, REQUIRED_ACCEPTED_PATHS[2], jsonBytes({ schemaVersion: 3, source, includedRoots: ["daily"], acceptedFiles: {}, ontologyCompilation: compiler }));
    await git(root, ["add", "."]); await git(root, ["update-index", "--add", "--cacheinfo", `160000,${oldSource},${sourcePath}`]);
    await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"]);
    const head = await git(root, ["rev-parse", "HEAD"]); await git(root, ["update-ref", "refs/remotes/origin/main", head]);
    const load = (commit = head) => loadAcceptedGitCheckpoint({ root, repository, commit });
    const capability = await load(); const options = await proposal(root, capability, sourceCommit);
    await callback({ root, archive, head, sourceCommit, oldSource, options, load });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function snapshot(root) {
  const working = {};
  async function walk(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      if (name === ".git") continue;
      const path = `${prefix}${name}`; const absolute = resolve(directory, name); const stat = await lstat(absolute);
      if (stat.isDirectory()) await walk(absolute, `${path}/`); else working[path] = (await readFile(absolute)).toString("base64");
    }
  }
  await walk(root);
  return { working, index: (await readFile(resolve(root, ".git/index"))).toString("base64"), head: await git(root, ["rev-parse", "HEAD"]), main: await git(root, ["rev-parse", "refs/heads/main"]), tracking: await git(root, ["rev-parse", "refs/remotes/origin/main"]) };
}
function transport(base, behavior = async () => {}) {
  let remote = base; let reads = 0; const pushes = [];
  return { pushes, get reads() { return reads; }, setRemote(value) { remote = value; },
    async readMain(request) { assert.deepEqual(request, { repository, ref: "refs/heads/main" }); reads++; if (remote instanceof Error) throw remote; return remote; },
    async pushFastForward(request) { pushes.push(request); assert.equal(request.force, false); assert.equal(request.ref, "refs/heads/main"); assert.equal(request.expectedBase, remote); return behavior(request, (value) => { remote = value; }); } };
}
async function install(root, prepared) { await git(root, ["reset", "--hard", prepared.commit]); await git(root, ["update-ref", "refs/remotes/origin/main", prepared.commit]); }

test("isolated preparation binds a single parent, exact payload and external gitlink without touching dirty caller state", async () => {
  await fixture(async ({ root, head, sourceCommit, options }) => {
    await put(root, "keep.txt", "staged user work"); await git(root, ["add", "keep.txt"]); await put(root, "keep.txt", "unstaged user work");
    await put(root, REQUIRED_ACCEPTED_PATHS[0], "untrusted dirty local KG"); await put(root, "untracked.txt", "private scratch bytes");
    const before = await snapshot(root); const result = await prepareAcceptedCommit(options);
    assert.deepEqual(await snapshot(root), before); assert.equal(result.expectedBase, head); assert.equal(result.noop, false); assert.match(result.payloadHash, /^[a-f0-9]{64}$/u);
    assert.equal(await git(root, ["rev-list", "--parents", "-n", "1", result.commit]), `${result.commit} ${head}`);
    assert.equal(await git(root, ["rev-parse", `${result.commit}^{tree}`]), result.tree);
    for (const [path, content] of options.acceptedFiles) assert.equal(await git(root, ["show", `${result.commit}:${path}`]), content.toString().trim());
    assert.deepEqual(JSON.parse(await git(root, ["show", `${result.commit}:data/accepted-release.json`])), options.manifest);
    assert.equal(await git(root, ["rev-parse", `${result.commit}:${sourcePath}`]), sourceCommit);
    await assert.rejects(git(root, ["cat-file", "-t", sourceCommit]));
    const changed = (await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", head, result.commit])).split("\n").sort();
    assert.deepEqual(changed, [...REQUIRED_ACCEPTED_PATHS, "data/accepted-release.json", sourcePath].sort());
    assert.equal((await prepareAcceptedCommit(options)).commit, result.commit, "same pinned payload and time are reproducible");
  });
});

test("partial staging and pre-commit/final-gate failures preserve all accepted refs, index and caller bytes", async () => {
  await fixture(async ({ root, options }) => {
    const before = await snapshot(root);
    for (const hook of ["afterStageFile", "beforeCommit", "beforeReturn"]) {
      await assert.rejects(prepareAcceptedCommit(options, { [hook]: () => { throw new Error(`fixture ${hook}`); } }), new RegExp(`fixture ${hook}`, "u"));
      assert.deepEqual(await snapshot(root), before);
    }
  });
});

test("unreviewed output paths, missing outputs and mismatched byte/manifest/source bindings fail closed", async () => {
  await fixture(async ({ root, options }) => {
    const before = await snapshot(root);
    for (const path of ["../escape.json", "data/raw/private.json", ".github/workflows/publish.yml", "data/accepted-release.json", "sources/bedtimenews-archive-contents"]) {
      await assert.rejects(prepareAcceptedCommit({ ...options, acceptedFiles: new Map([...options.acceptedFiles, [path, Buffer.from("{}")]]) }), /unreviewed accepted path/u);
    }
    const missing = new Map(options.acceptedFiles); missing.delete(REQUIRED_ACCEPTED_PATHS[0]);
    await assert.rejects(prepareAcceptedCommit({ ...options, acceptedFiles: missing }), /required accepted outputs/u);
    const changed = new Map(options.acceptedFiles); changed.set(REQUIRED_ACCEPTED_PATHS[0], Buffer.from("{}"));
    await assert.rejects(prepareAcceptedCommit({ ...options, acceptedFiles: changed }), /bytes differ/u);
    const manifest = clone(options.manifest); manifest.source.commit = "f".repeat(40); manifest.releaseId = acceptedReleaseIdentity(manifest);
    await assert.rejects(prepareAcceptedCommit({ ...options, manifest }), /source commit mismatch/u);
    const untrusted = clone(options.manifest); untrusted.origin.commit = "e".repeat(40);
    await assert.rejects(prepareAcceptedCommit({ ...options, manifest: untrusted }), /epoch mismatch|identity mismatch/u);
    await assert.rejects(prepareAcceptedCommit({ ...options, checkpoint: { ...options.checkpoint } }), /not a capability/u);
    assert.deepEqual(await snapshot(root), before);
  });
});

test("uncommitted configuration or generator edits cannot claim the old accepted code commit", async () => {
  await fixture(async ({ root, sourceCommit, options }) => {
    for (const path of ["data/extraction-rules.json", "scripts/lib/kg-build.mjs"]) {
      const before = await readFile(resolve(root, path)); await put(root, path, "uncommitted changed semantic input\n");
      const altered = await proposal(root, options.checkpoint, sourceCommit);
      await assert.rejects(prepareAcceptedCommit(altered), /configuration differs from accepted code commit/u);
      await put(root, path, before);
    }
    const manifest = clone(options.manifest); manifest.codeCommit = "e".repeat(40); manifest.auditReceipt.targetCommit = manifest.codeCommit; manifest.releaseId = acceptedReleaseIdentity(manifest);
    await assert.rejects(prepareAcceptedCommit({ ...options, manifest }), /code commit differs from expected base/u);
  });
});

test("trusted continuation rejects stale or fabricated predecessors and preserves origin", async () => {
  await fixture(async ({ root, options, load, sourceCommit }) => {
    const first = await prepareAcceptedCommit(options); await install(root, first);
    const next = await proposal(root, await load(first.commit), sourceCommit, "second");
    const prepared = await prepareAcceptedCommit(next);
    assert.equal(prepared.expectedBase, first.commit); assert.equal(next.manifest.origin.commit, options.manifest.origin.commit);
    const wrong = clone(next.manifest); wrong.predecessor.commit = options.manifest.origin.commit; wrong.releaseId = acceptedReleaseIdentity(wrong);
    await assert.rejects(prepareAcceptedCommit({ ...next, manifest: wrong }), /trusted predecessor\/candidate reconstruction/u);
    await assert.rejects(prepareAcceptedCommit(options), /exact pinned/u);
  });
});

test("no-op reuses the exact accepted commit and gitlink without staging or pushing", async () => {
  await fixture(async ({ root, archive, options, load }) => {
    const first = await prepareAcceptedCommit(options); await install(root, first);
    await put(archive, "unrelated.md", "source-only commit movement"); await commit(archive);
    const before = await snapshot(root);
    const noop = await prepareAcceptedCommit({ ...options, checkpoint: await load(first.commit), noop: true }, { afterStageFile: () => assert.fail("must not stage") });
    assert.equal(noop.commit, first.commit); assert.equal(noop.sourceCommit, first.sourceCommit); assert.deepEqual(await snapshot(root), before);
    const remote = transport(first.commit); const outcome = await promoteAcceptedCommit({ prepared: noop, transport: remote });
    assert.equal(outcome.status, "noop"); assert.equal(outcome.publicationPending, false); assert.equal(remote.pushes.length, 0);
    await assert.rejects(prepareAcceptedCommit({ ...options, checkpoint: await load(first.commit), noop: true, candidateManifest: { ...options.candidateManifest, bundleId: "f".repeat(64) } }), /no-op candidate/u);
  });
});

test("stale/diverged remote main and failed reads refuse any push", async () => {
  await fixture(async ({ options }) => {
    const prepared = await prepareAcceptedCommit(options);
    for (const [value, status] of [["f".repeat(40), "stale"], [new Error("private remote URL"), "unresolved"], ["main", "unresolved"]]) {
      const remote = transport(value); const result = await promoteAcceptedCommit({ prepared, transport: remote });
      assert.equal(result.status, status); assert.equal(result.accepted, null); assert.equal(remote.pushes.length, 0); assert.ok(!JSON.stringify(result).includes("private remote"));
    }
  });
});

test("push success and lost response both require exact remote readback and preserve local accepted main", async () => {
  await fixture(async ({ root, options, head }) => {
    const prepared = await prepareAcceptedCommit(options); const before = await snapshot(root);
    for (const lost of [false, true]) {
      const remote = transport(head, async (request, advance) => { advance(request.commit); if (lost) throw new Error("lost response with secret credential"); });
      const result = await promoteAcceptedCommit({ prepared, transport: remote });
      assert.equal(result.status, "accepted"); assert.equal(result.accepted, true); assert.equal(result.publicationPending, true);
      assert.equal(result.pushResponse, lost ? "uncertain" : "returned"); assert.equal(remote.pushes.length, 1); assert.equal(remote.reads, 2);
      assert.deepEqual(remote.pushes[0], { repository, ref: "refs/heads/main", expectedBase: head, commit: prepared.commit, force: false });
      const again = await promoteAcceptedCommit({ prepared, transport: remote }); assert.equal(again.status, "accepted"); assert.equal(again.pushAttempted, false); assert.equal(remote.pushes.length, 1);
      assert.deepEqual(await snapshot(root), before);
    }
  });
});

test("failed and uncertain pushes are reconciled once, never blindly retried", async () => {
  await fixture(async ({ options, head }) => {
    const prepared = await prepareAcceptedCommit(options);
    for (const [after, status, accepted] of [[head, "not-accepted", false], [new Error("offline"), "unresolved", null], ["f".repeat(40), "stale", null]]) {
      const remote = transport(head, async (_request, change) => { change(after); throw new Error("lost push response"); });
      const result = await promoteAcceptedCommit({ prepared, transport: remote });
      assert.equal(result.status, status); assert.equal(result.accepted, accepted); assert.equal(result.publicationPending, false); assert.equal(remote.pushes.length, 1); assert.equal(remote.reads, 2);
      assert.equal((await reconcileAcceptedCommit({ prepared, transport: remote })).status, status); assert.equal(remote.pushes.length, 1);
    }
    const lying = transport(head); const result = await promoteAcceptedCommit({ prepared, transport: lying });
    assert.equal(result.status, "not-accepted", "a successful API response is not evidence that main advanced");
  });
});

test("crash recovery checks exact commit/tree/payload and resumes read-only publication decisions", async () => {
  await fixture(async ({ root, options, head }) => {
    const prepared = await prepareAcceptedCommit(options); const saved = JSON.parse(JSON.stringify(prepared));
    await assert.rejects(reconcileAcceptedCommit({ prepared: saved, transport: transport(head) }), /serialized descriptor is not authority/u);
    const recovered = await recoverPreparedAcceptedCommit({ root, ...saved });
    assert.deepEqual(recovered, prepared);
    const remote = transport(prepared.commit); const result = await reconcileAcceptedCommit({ prepared: recovered, transport: remote });
    assert.equal(result.accepted, true); assert.equal(result.publicationPending, true); assert.equal(remote.pushes.length, 0);
    await assert.rejects(promoteAcceptedCommit({ prepared: recovered, transport: transport(head) }), /reconciliation-only/u);
    await assert.rejects(recoverPreparedAcceptedCommit({ root, ...saved, payloadHash: "f".repeat(64) }), /recovered payload differs/u);
    await assert.rejects(recoverPreparedAcceptedCommit({ root, ...saved, expectedBase: "f".repeat(40) }), /exactly the expected base parent/u);
  });
});

test("recovery refuses commits that alter unreviewed paths, wrong gitlinks or multiple parents", async () => {
  await fixture(async ({ root, options, head, oldSource }) => {
    const prepared = await prepareAcceptedCommit(options);
    await install(root, prepared);
    await put(root, "README.md", "injected non-target change"); const changed = await commit(root);
    const changedTree = await git(root, ["rev-parse", `${changed}^{tree}`]);
    const forged = await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", changedTree, "-p", head, "-m", "forged"]);
    await assert.rejects(recoverPreparedAcceptedCommit({ root, ...prepared, commit: forged }), /non-target path/u);
    const merge = await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", prepared.tree, "-p", head, "-p", changed, "-m", "merge"]);
    await assert.rejects(recoverPreparedAcceptedCommit({ root, ...prepared, commit: merge }), /exactly the expected base parent/u);
    await git(root, ["reset", "--hard", prepared.commit]); await git(root, ["update-index", "--cacheinfo", `160000,${oldSource},${sourcePath}`]);
    const wrongTree = await git(root, ["write-tree"]); const wrong = await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", wrongTree, "-p", head, "-m", "wrong pointer"]);
    await assert.rejects(recoverPreparedAcceptedCommit({ root, ...prepared, commit: wrong }), /source gitlink differs/u);
  });
});

test("hostile Git environment variables cannot redirect isolated preparation", async () => {
  await fixture(async ({ root, options }) => {
    const names = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_CONFIG_COUNT"]; const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const before = await snapshot(root);
    try {
      process.env.GIT_DIR = "/missing/repository"; process.env.GIT_INDEX_FILE = "/missing/index"; process.env.GIT_WORK_TREE = "/missing/worktree"; process.env.GIT_CONFIG_COUNT = "bogus";
      await prepareAcceptedCommit(options);
    } finally { for (const name of names) if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    assert.deepEqual(await snapshot(root), before);
  });
});

test("candidate verification must bind the trusted checkpoint even when all public hashes are recomputed", async () => {
  await fixture(async ({ options }) => {
    const candidateManifest = clone(options.candidateManifest);
    candidateManifest.inputs.verification.originCommit = "f".repeat(40);
    const verification = { ...candidateManifest.inputs.verification }; delete verification.sha256;
    candidateManifest.inputs.verification.sha256 = hash(verification);
    const candidatePayload = { ...candidateManifest }; delete candidatePayload.bundleId;
    candidateManifest.bundleId = hash(candidatePayload);
    const manifest = clone(options.manifest); manifest.candidateBundleId = candidateManifest.bundleId; manifest.candidateManifestHash = hash(candidateManifest);
    manifest.auditReceipt = receiptFor(candidateManifest, manifest.codeCommit); manifest.releaseId = acceptedReleaseIdentity(manifest);
    await assert.rejects(prepareAcceptedCommit({ ...options, candidateManifest, manifest }), /verification differs from trusted checkpoint/u);
  });
});

test("checkpoint races during staging or before return cannot advance an accepted ref", async () => {
  await fixture(async ({ root, head, options }) => {
    const tree = await git(root, ["rev-parse", `${head}^{tree}`]);
    const competitor = await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-p", head, "-m", "competing release"]);
    for (const hook of ["afterStageFile", "beforeReturn"]) {
      const before = await snapshot(root);
      await assert.rejects(prepareAcceptedCommit(options, { [hook]: async () => { await git(root, ["update-ref", "refs/remotes/origin/main", competitor]); } }), /exact pinned|main differs/u);
      assert.deepEqual(await snapshot(root), { ...before, tracking: competitor });
      await git(root, ["update-ref", "refs/remotes/origin/main", head]);
    }
  });
});

test("rollback is a new single-parent acceptance restoring trusted target bytes and source pointer", async () => {
  await fixture(async ({ root, sourceCommit, options, load }) => {
    const first = await prepareAcceptedCommit(options); await install(root, first);
    const secondOptions = await proposal(root, await load(first.commit), sourceCommit, "second");
    const second = await prepareAcceptedCommit(secondOptions); await install(root, second);
    const rollbackOptions = await proposal(root, await load(second.commit), sourceCommit, "new");
    const rollbackCheckpoint = await loadAcceptedGitCheckpoint({ root, repository, commit: first.commit, allowAncestor: true });
    const current = await readVerifiedAcceptedCheckpoint(rollbackOptions.checkpoint);
    const target = await readVerifiedAcceptedCheckpoint(rollbackCheckpoint);
    const binding = rollbackReviewBinding(current, target);
    const transition = validateRollbackReview({ ...binding, reviewedAt: generatedAt, reason: "Restore the exact reviewed accepted fixture" }, binding);
    const candidateManifest = clone(rollbackOptions.candidateManifest);
    candidateManifest.inputs.verification = candidateVerificationBinding(current, { rollbackTarget: target });
    candidateManifest.inputs.transition = transition;
    delete candidateManifest.bundleId; candidateManifest.bundleId = hash(candidateManifest);
    const manifest = createAcceptedRelease({ candidateManifest, lifecycle: rollbackOptions.lifecycle, acceptedFiles: rollbackOptions.acceptedFiles,
      origin: rollbackOptions.manifest.origin, predecessor: rollbackOptions.manifest.predecessor,
      codeCommit: second.commit, sourceCommit, auditReceipt: receiptFor(candidateManifest, second.commit),
      mode: "rollback", transition, rollbackTarget: { commit: first.commit, releaseId: first.releaseId, bundleId: first.bundleId },
      verifiedPredecessor: { commit: second.commit, manifest: current.manifest }, verifiedRollbackTarget: { commit: first.commit, manifest: target.manifest }, auditRepository: repository });
    const updated = { ...rollbackOptions, candidateManifest, manifest };
    const rollback = await prepareAcceptedCommit({ ...updated, rollbackCheckpoint });
    assert.equal(rollback.expectedBase, second.commit); assert.notEqual(rollback.commit, first.commit);
    assert.equal(rollback.sourceCommit, first.sourceCommit);
    for (const path of REQUIRED_ACCEPTED_PATHS.slice(0, 2)) assert.equal(await git(root, ["rev-parse", `${rollback.commit}:${path}`]), await git(root, ["rev-parse", `${first.commit}:${path}`]));
    await assert.rejects(prepareAcceptedCommit(updated), /rollback target|verification differs/u);
    await assert.rejects(prepareAcceptedCommit({ ...updated, rollbackCheckpoint: { ...rollbackCheckpoint } }), /not a capability/u);
  });
});

async function migrationFixture(callback) {
  await fixture(async (f) => {
    const first = await prepareAcceptedCommit(f.options); await install(f.root, first);
    await git(f.root, ["switch", "-c", "feat/reviewed-migration"]);
    await put(f.root, "scripts/lib/kg-build.mjs", "export const generator = 2;\n");
    const proposalCommit = await commit(f.root), checkpoint = await f.load(first.commit);
    const value = await proposal(f.root, checkpoint, f.sourceCommit, "migrated", proposalCommit);
    const options = { ...value, proposalCommit, proposalRef: "refs/heads/feat/reviewed-migration" };
    await callback({ ...f, first, options });
  });
}

test("reviewed migration prepares coherent code/data on the proposal branch and never authorizes main CAS", async () => {
  await migrationFixture(async ({ root, first, options, load }) => {
    const before = await snapshot(root);
    const prepared = await prepareReviewedMigrationCommit(options);
    assert.deepEqual(await snapshot(root), before);
    assert.equal(prepared.kind, "prepared-reviewed-migration-pr"); assert.equal(prepared.accepted, false);
    assert.equal(prepared.expectedMain, first.commit); assert.equal(prepared.proposalCommit, options.proposalCommit);
    assert.equal(await git(root, ["rev-parse", `${prepared.commit}^`]), options.proposalCommit);
    await assert.rejects(promoteAcceptedCommit({ prepared, transport: transport(first.commit) }), /not authority/u);
    await assert.rejects(prepareAcceptedCommit(options), /coherent code-and-data review PR/u);
    await git(root, ["checkout", "main"]);
    await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--no-ff", "-m", "Reviewed migration", prepared.commit]);
    const merged = await git(root, ["rev-parse", "HEAD"]); await git(root, ["update-ref", "refs/remotes/origin/main", merged]);
    const accepted = await readVerifiedAcceptedCheckpoint(await load(merged));
    assert.equal(accepted.manifest.codeCommit, options.proposalCommit); assert.equal(accepted.manifest.predecessor.commit, first.commit);
    assert.equal(accepted.manifest.releaseId, prepared.releaseId);
    for (const [path, content] of options.acceptedFiles) assert.deepEqual(accepted.files.get(path), content);
  });
});

test("migration PR preparation rejects main targets and accepted/workflow changes before generation", async () => {
  await migrationFixture(async ({ root, options }) => {
    await assert.rejects(inspectReviewedMigrationProposal({ ...options, proposalRef: "refs/heads/main" }), /non-main/u);
    await assert.rejects(inspectReviewedMigrationProposal({ ...options, proposalRef: "refs/tags/review" }), /non-main/u);
    await put(root, ".github/workflows/extra.yml", "name: separate review required\n");
    const changed = await commit(root);
    await assert.rejects(inspectReviewedMigrationProposal({ ...options, proposalCommit: changed }), /workflow\/source-remote changes/u);
    await put(root, REQUIRED_ACCEPTED_PATHS[0], "{}\n"); const mixed = await commit(root);
    await assert.rejects(inspectReviewedMigrationProposal({ ...options, proposalCommit: mixed }), /changed accepted output/u);
  });
});

test("migration PR preparation fails on stale proposal or moving main without altering accepted refs", async () => {
  await migrationFixture(async ({ root, first, options }) => {
    const tree = await git(root, ["rev-parse", `${first.commit}^{tree}`]);
    const competing = await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-p", first.commit, "-m", "competing"]);
    await assert.rejects(prepareReviewedMigrationCommit(options, { beforeReturn: () => git(root, ["update-ref", "refs/remotes/origin/main", competing]) }), /exact pinned|main differs/u);
    assert.equal(await git(root, ["rev-parse", "refs/heads/main"]), first.commit);
    await git(root, ["update-ref", "refs/remotes/origin/main", first.commit]);
    await assert.rejects(prepareReviewedMigrationCommit(options, { beforeCommit: () => git(root, ["update-ref", options.proposalRef, first.commit]) }), /proposal branch or checkout/u);
    assert.equal(await git(root, ["rev-parse", "refs/heads/main"]), first.commit);
  });
});
