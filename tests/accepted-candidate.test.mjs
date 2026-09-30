import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { buildAcceptedCandidate, verifyAcceptedCandidate, previewAcceptedMigration, buildAcceptedRollback, verifyAcceptedRollback, ACCEPTED_CANDIDATE_VERSION } from "../scripts/lib/accepted-candidate.mjs";
import { loadAcceptedGitCheckpoint } from "../scripts/lib/accepted-git.mjs";
import { createAcceptedRelease, acceptedReleaseIdentity, validateAcceptedReleaseStructure, REQUIRED_ACCEPTED_PATHS } from "../scripts/lib/accepted-release.mjs";
import { sourceInventory } from "../scripts/lib/candidate-run.mjs";
import { canonicalJson, sha256, verifyCandidateBundle } from "../scripts/lib/candidate-bundle.mjs";
import { verifyLifecycleCandidate } from "../scripts/lib/lifecycle-run.mjs";
import { rollbackReviewBinding } from "../scripts/lib/accepted-transition.mjs";
import { readVerifiedAcceptedCheckpoint } from "../scripts/lib/accepted-git.mjs";
import { assignedEntityAssertionId, buildReviewedIdentityInputHash } from "../scripts/lib/entity-identities.mjs";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));
const generatedAt = "2026-01-03T00:00:00Z";
const repository = "fixture/accepted-kg";
const jsonBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const hash = (value) => sha256(canonicalJson(value));
const run = (cwd, command, args) => execFile(command, args, { cwd, maxBuffer: 2 * 1024 * 1024 });
const git = (cwd, args) => run(cwd, "git", args);
const head = async (cwd) => (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
async function commit(directory, paths = ["."]) {
  await git(directory, ["add", "--", ...paths]);
  await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture revision"]);
  return head(directory);
}
async function acceptedBytes(directory) {
  return Promise.all(REQUIRED_ACCEPTED_PATHS.map((path) => readFile(resolve(directory, path), "utf8")));
}
function sourceText(day, body = "北京市华为介绍工资与排班情况。") {
  return `---\ntitle: 华为工资与排班\npublished: true\ndateCreated: ${day}T00:00:00Z\n---\n\n${body}\n`;
}
function receiptFor(manifest, codeCommit, id = 1) {
  const tag = `kg-audit-${manifest.bundleId}`;
  const files = { ...manifest.artifacts, "manifest.json": { bytes: jsonBytes(manifest).length, sha256: sha256(jsonBytes(manifest)) } };
  return { schemaVersion: 2, kind: "github-audit-readback", repository, bundleId: manifest.bundleId,
    manifestSha256: files["manifest.json"].sha256, targetCommit: codeCommit, tag, releaseId: id,
    releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`, githubImmutableAtReadback: false, visibilityAtReadback: "draft", readbackVerified: true,
    assets: Object.fromEntries(Object.entries(files).map(([name, descriptor], index) => {
      const assetName = `${descriptor.sha256}-${name}`;
      return [name, { ...descriptor, id: index + 100, name: assetName, url: `https://github.com/${repository}/releases/download/${tag}/${assetName}` }];
    })), rawSourceArchiveIncluded: false,
    sourceReplay: "Restoring accepted outputs does not guarantee raw upstream re-extraction; upstream Git history must be available separately." };
}

async function workspace(callback, configureArchive) {
  const directory = await mkdtemp(resolve(tmpdir(), "accepted-candidate-"));
  try {
    await cp(resolve(root, "scripts"), resolve(directory, "scripts"), { recursive: true });
    await cp(resolve(root, "app/lib"), resolve(directory, "app/lib"), { recursive: true });
    await mkdir(resolve(directory, "data/generated"), { recursive: true }); await mkdir(resolve(directory, "data/processed"));
    for (const path of ["ontology-source.json", "ontology.json", "extraction-patterns.json", "extraction-rules.json", "news-overrides.json"]) await cp(resolve(root, "data", path), resolve(directory, "data", path));
    const archive = resolve(directory, "sources/bedtimenews-archive-contents");
    await mkdir(resolve(archive, "daily"), { recursive: true });
    for (const day of ["2026-01-01", "2026-01-02"]) await writeFile(resolve(archive, `daily/${day}.md`), sourceText(day));
    await writeFile(resolve(archive, "daily/excluded.md"), "---\ntitle: Excluded\npublished: false\n---\nNot published.\n");
    if (configureArchive) await configureArchive(archive);
    await git(archive, ["init", "-q"]); await commit(archive);
    await run(directory, process.execPath, ["scripts/update-kg.mjs", "--bootstrap", "--source", archive, "--include", "daily"]);
    await writeFile(resolve(directory, ".gitignore"), "work/\n*.review.json\n");
    await git(directory, ["init", "-q"]);
    await git(directory, ["remote", "add", "origin", `https://github.com/${repository}.git`]);
    await commit(directory);
    await git(directory, ["update-ref", "refs/remotes/origin/main", await head(directory)]);
    const audit = new Map();
    const store = { async readBundle({ receipt }) {
      const saved = audit.get(receipt.bundleId); assert.ok(saved, "fixture audit bundle must exist");
      assert.deepEqual(receipt, saved.receipt);
      return { manifest: structuredClone(saved.manifest), files: new Map([...saved.files].map(([name, content]) => [name, Buffer.from(content)])) };
    } };
    const load = async () => loadAcceptedGitCheckpoint({ root: directory, repository, commit: await head(directory) });
    const build = async (name, options = {}, hooks = {}) => buildAcceptedCandidate(directory, { source: archive, output: `work/accepted/${name}`, generatedAt, checkpoint: await load(), store, ...options }, hooks);
    const accept = async (result) => {
      assert.equal(result.noop, false);
      const files = new Map();
      for (const name of [...Object.keys(result.manifest.artifacts), "manifest.json"]) files.set(name, await readFile(resolve(result.output, name)));
      const codeCommit = await head(directory);
      const receipt = receiptFor(result.manifest, codeCommit, audit.size + 1);
      const release = createAcceptedRelease({ candidateManifest: result.manifest, lifecycle: result.artifacts["lifecycle.json.gz"], acceptedFiles: result.acceptedFiles,
        origin: result.origin, predecessor: result.checkpoint ? { commit: result.checkpoint.commit, releaseId: result.checkpoint.manifest.releaseId, bundleId: result.checkpoint.manifest.candidateBundleId } : null,
        codeCommit, sourceCommit: result.manifest.inputs.recipe.archiveCommit, auditReceipt: receipt, mode: result.mode, transition: result.transition,
        rollbackTarget: result.rollbackTarget ? { commit: result.rollbackTarget.commit, releaseId: result.rollbackTarget.manifest.releaseId, bundleId: result.rollbackTarget.manifest.candidateBundleId } : null,
        verifiedRollbackTarget: result.rollbackTarget ?? null, verifiedPredecessor: result.checkpoint, auditRepository: repository });
      audit.set(result.manifest.bundleId, { manifest: result.manifest, files, receipt });
      for (const [path, content] of result.acceptedFiles) await writeFile(resolve(directory, path), content);
      await writeFile(resolve(directory, "data/accepted-release.json"), jsonBytes(release));
      const acceptedCommit = await commit(directory, ["data", "sources"]);
      await git(directory, ["update-ref", "refs/remotes/origin/main", acceptedCommit]);
      return { manifest: release, commit: acceptedCommit };
    };
    const review = async (baseline, name, decisions) => {
      const current = await sourceInventory(archive, ["daily"], { allowEmpty: true });
      const lifecycle = baseline.artifacts["lifecycle.json.gz"];
      const old = lifecycle.observedInventory;
      const value = { schemaVersion: 1, baselineBundleId: baseline.manifest.bundleId, baselineInventoryHash: hash(old), currentInventoryHash: hash(current), reviewedAt: generatedAt,
        reason: "Fixture reviewed source transition", decisions: decisions.map(({ path, operation }) => ({ path, operation,
          fromHash: operation === "restore" ? lifecycle.sourceStates[path].lastHash : old[path] ?? null, toHash: current[path] ?? null, reason: "Fixture exact review" })) };
      const path = resolve(directory, `${name}.review.json`); await writeFile(path, JSON.stringify(value, null, 2) + "\n"); return { sourceReview: path };
    };
    await callback({ directory, archive, build, accept, load, store, audit, review });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("trusted production candidates survive two acceptances and repeated true no-ops without parent churn", async () => {
  await workspace(async ({ directory, archive, build, accept, store, load }) => {
    const seed = await build("seed");
    assert.equal(seed.manifest.versions.candidate, ACCEPTED_CANDIDATE_VERSION);
    assert.equal(seed.classification.classification, "bootstrap");
    assert.equal((await verifyAcceptedCandidate(directory, seed.output, { source: archive, checkpoint: await load(), store })).verificationVersion, "1.0.0");
    await accept(seed);
    const originalBindings = Object.fromEntries(["acceptedState", "acceptedKG", "acceptedNews"].map((name) => [name, seed.manifest.inputs[name]]));
    for (const day of ["2026-01-03", "2026-01-04"]) {
      await writeFile(resolve(archive, `daily/${day}.md`), sourceText(day)); await commit(archive);
      const result = await build(day);
      assert.equal(result.noop, false);
      for (const [name, binding] of Object.entries(originalBindings)) assert.deepEqual(result.manifest.inputs[name], binding);
      assert.equal(result.metrics.historyBundles, 0);
      await accept(result);
    }
    const before = await acceptedBytes(directory);
    const release = JSON.parse(await readFile(resolve(directory, "data/accepted-release.json"), "utf8"));
    for (const name of ["noop-1", "noop-2"]) {
      await commit(archive); // A new source commit/time alone is not a release.
      const repeated = await build(name, { generatedAt: "2026-02-01T00:00:00Z" });
      assert.equal(repeated.noop, true); assert.equal(repeated.classification.classification, "noop");
      assert.equal(repeated.manifest.bundleId, release.candidateBundleId); assert.equal(repeated.output, null);
      await assert.rejects(readFile(resolve(directory, `work/accepted/${name}/manifest.json`)), /ENOENT/u);
    }
    assert.deepEqual(await acceptedBytes(directory), before);
    await assert.rejects(verifyLifecycleCandidate(directory, "work/accepted/seed", { source: archive, historyRoot: "work/accepted" }), /configuration|origin|historical|binding/u);
  });
});

test("operational and documentation changes do not force a semantic migration", async () => {
  await workspace(async ({ directory, build, accept }) => {
    const seed = await build("seed"); await accept(seed);
    await writeFile(resolve(directory, "README.md"), "Updated operational documentation.\n");
    const operational = resolve(directory, "scripts/lib/release-sync.mjs");
    await writeFile(operational, `${await readFile(operational, "utf8")}\n// Reviewed operational-only change.\n`);
    const next = await commit(directory, ["README.md", "scripts/lib/release-sync.mjs"]);
    await git(directory, ["update-ref", "refs/remotes/origin/main", next]);
    const result = await build("after-ops");
    assert.equal(result.noop, true);
    assert.equal(result.manifest.bundleId, seed.manifest.bundleId);
    assert.equal(result.acceptedFiles.size, 6);
  });
});

test("semantic migration needs an exact old/new axes and diff review, then continues in its new epoch", async () => {
  await workspace(async ({ directory, archive, build, accept, load, store }) => {
    const seed = await build("seed"); const original = await accept(seed);
    const overridePath = resolve(directory, "data/news-overrides.json");
    const overrides = JSON.parse(await readFile(overridePath, "utf8")); overrides.version = "1.1.2";
    await writeFile(overridePath, `${JSON.stringify(overrides, null, 2)}\n`);
    const patternsPath = resolve(directory, "data/extraction-patterns.json");
    const patterns = JSON.parse(await readFile(patternsPath, "utf8")); patterns.version = "4.1.1";
    patterns.topics.find((topic) => topic.conceptId === "topic-labor").extractionTriggers = ["审核后的劳动锚点"];
    await writeFile(patternsPath, `${JSON.stringify(patterns, null, 2)}\n`);
    await run(directory, process.execPath, ["scripts/compile-ontology.mjs"]);
    const code = await commit(directory, ["data/news-overrides.json", "data/extraction-patterns.json", "data/extraction-rules.json", "data/ontology.json"]);
    await git(directory, ["update-ref", "refs/remotes/origin/main", code]);
    await assert.rejects(build("unreviewed-migration"), /explicit migration required/u);
    const preview = await previewAcceptedMigration(directory, { source: archive, checkpoint: await load(), store, generatedAt });
    assert.equal(preview.accepted, false); assert.notEqual(preview.reviewBinding.fromHash, preview.reviewBinding.toHash);
    assert.equal(preview.reviewBinding.baseline.releaseId, original.manifest.releaseId);
    const migrationReview = resolve(directory, "migration.review.json");
    const approval = { ...preview.reviewBinding, reviewedAt: generatedAt, reason: "Review exact override-version migration and its complete diff" };
    await writeFile(migrationReview, jsonBytes({ ...approval, diffHash: sha256("stale reviewed diff") }));
    await assert.rejects(build("stale-migration", { migrationReview }), /exact predecessor.*diff/u);
    await writeFile(migrationReview, jsonBytes(approval));
    const result = await build("migrated", { migrationReview });
    assert.equal(result.mode, "migration"); assert.equal(result.transition.review.diffHash, result.manifest.artifacts["diff.json"].sha256);
    assert.equal(result.artifacts["kg.json"].source.extractionVersion, "4.1.1");
    const labor = seed.artifacts["kg.json"].entities.find((entity) => entity.type === "topic" && entity.label.includes("劳动")); assert.ok(labor);
    assert.ok(!result.artifacts["kg.json"].entities.some((entity) => entity.id === labor.id));
    assert.ok(result.artifacts["diff.json"].graph.summary.removed > 0);
    assert.equal((await verifyAcceptedCandidate(directory, result.output, { source: archive, checkpoint: await load(), store })).mode, "migration");
    const accepted = await accept(result);
    assert.notEqual(accepted.manifest.epochId, original.manifest.epochId);
    assert.equal((await build("new-epoch-noop")).noop, true);
    await assert.rejects(build("unused-review", { migrationReview }), /unused/u);
    assert.equal(JSON.parse(result.acceptedFiles.get("data/review/ontology-candidates.json")).coverage.totalNews, result.artifacts["kg.json"].events.length);
  });
});

test("forward rollback restores exact archived outputs without raw sources and retains newer dormant identities and tombstones", async () => {
  await workspace(async ({ directory, archive, build, accept, load, store, review }) => {
    const seed = await build("seed"); const target = await accept(seed);
    const newPath = "daily/2026-01-03.md";
    await writeFile(resolve(archive, newPath), sourceText("2026-01-03", "上海市介绍地方情况。").replace("title: 华为工资与排班", "title: 上海地方情况")); await commit(archive);
    const laterWithdrawn = "daily/post-target-excluded.md";
    await writeFile(resolve(archive, laterWithdrawn), "---\ntitle: Later excluded page\npublished: false\n---\nA later unpublished source.\n"); await commit(archive);
    const added = await build("added"); await accept(added);
    const addedNews = added.artifacts["news.json"].news.find((item) => !seed.artifacts["news.json"].news.some((old) => old.id === item.id)); assert.ok(addedNews);
    const laterPath = "daily/excluded.md";
    const withdrawn = await build("withdrawn", await review(added, "withdraw-excluded", [{ path: laterPath, operation: "retract" }, { path: laterWithdrawn, operation: "retract" }]));
    await accept(withdrawn);
    const checkpoint = await load();
    const rollbackCheckpoint = await loadAcceptedGitCheckpoint({ root: directory, repository, commit: target.commit, allowAncestor: true });
    const rollbackReview = resolve(directory, "rollback.review.json");
    const binding = rollbackReviewBinding(await readVerifiedAcceptedCheckpoint(checkpoint), await readVerifiedAcceptedCheckpoint(rollbackCheckpoint));
    await writeFile(rollbackReview, jsonBytes({ ...binding, reviewedAt: "2026-01-05T00:00:00Z", reason: "Restore the reviewed seed projection" }));
    const away = `${archive}-unavailable`;
    await rename(archive, away);
    try {
      const options = { checkpoint, rollbackCheckpoint, rollbackReview, store, output: "work/accepted/rollback" };
      const restored = await buildAcceptedRollback(directory, options);
      assert.equal(restored.mode, "rollback"); assert.equal(restored.freshSourceReplay, false);
      const lifecycle = restored.artifacts["lifecycle.json.gz"];
      assert.equal(lifecycle.parentBundleId, withdrawn.manifest.bundleId);
      assert.equal(lifecycle.states.news.find((row) => row.id === addedNews.id).state, "dormant");
      assert.equal(lifecycle.sourceStates[newPath].status, "deleted");
      assert.deepEqual(lifecycle.sourceStates[laterWithdrawn], withdrawn.artifacts["lifecycle.json.gz"].sourceStates[laterWithdrawn]);
      // The explicitly targeted seed restores its active excluded source.
      assert.equal(lifecycle.sourceStates[laterPath], undefined);
      for (const path of REQUIRED_ACCEPTED_PATHS.slice(0, 2)) assert.ok(restored.acceptedFiles.get(path).equals(seed.acceptedFiles.get(path)));
      assert.equal((await verifyAcceptedRollback(directory, restored.output, options)).freshSourceReplay, false);
      // Source availability is not needed to construct or verify the candidate.
      await rename(away, archive);
      await git(archive, ["checkout", "--detach", restored.manifest.inputs.recipe.archiveCommit]);
      const release = await accept(restored);
      assert.equal(release.manifest.predecessor.bundleId, withdrawn.manifest.bundleId);
      assert.equal(release.manifest.rollbackTarget.releaseId, target.manifest.releaseId);
      assert.equal((await build("continued-after-rollback")).noop, true);
    } finally {
      try { await rename(away, archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  });
});

test("a semantic migration review cannot authorize a segmentation split without news identity mapping", async () => {
  await workspace(async ({ directory, archive, build, accept, load, store }) => {
    await accept(await build("seed"));
    const path = resolve(directory, "data/news-overrides.json");
    const overrides = JSON.parse(await readFile(path, "utf8")); overrides.version = "1.1.2";
    await writeFile(path, `${JSON.stringify(overrides, null, 2)}\n`);
    const options = { source: archive, checkpoint: await load(), store, generatedAt };
    const preview = await previewAcceptedMigration(directory, options);
    const migrationReview = resolve(directory, "split.review.json");
    await writeFile(migrationReview, jsonBytes({ ...preview.reviewBinding, reviewedAt: generatedAt, reason: "A semantic review does not grant boundary identity mapping" }));
    overrides.pages["daily/2026-01-01.md"] = { boundaryMarkers: ["北京市介绍第一条", "上海市介绍第二条"] };
    await writeFile(path, `${JSON.stringify(overrides, null, 2)}\n`);
    await assert.rejects(previewAcceptedMigration(directory, options), /news-boundary identity mapping not implemented/u);
    await assert.rejects(build("split", { migrationReview }), /news-boundary identity mapping not implemented/u);
    await assert.rejects(readFile(resolve(directory, "work/accepted/split/manifest.json")), /ENOENT/u);
  }, async (archive) => {
    await writeFile(resolve(archive, "daily/2026-01-01.md"), sourceText("2026-01-01",
      "北京市介绍第一条劳动新闻，这里讨论工资与排班的安排，包含完整的背景信息并且继续记录公开报道的内容。\n\n上海市介绍第二条劳动新闻，这里讨论工资与排班的安排，包含完整的背景信息并且继续记录公开报道的内容。"));
  });
});

test("reviewed withdrawals and restoration keep older bundle-scoped references across accepted checkpoints", async () => {
  await workspace(async ({ directory, archive, build, accept, review }) => {
    const seed = await build("seed"); await accept(seed);
    const huawei = seed.artifacts["kg.json"].entities.find((item) => item.label === "华为"); assert.ok(huawei);
    const path = "daily/2026-01-01.md";
    const withdrawn = await build("withdrawn", await review(seed, "retract", [{ path, operation: "retract" }]));
    assert.equal(withdrawn.artifacts["news.json"].news.length, 1);
    const dormant = withdrawn.artifacts["lifecycle.json.gz"].states.entities.find((row) => row.id === huawei.id);
    assert.equal(dormant.state, "dormant"); assert.equal(dormant.recordRef.bundleId, seed.manifest.bundleId);
    await accept(withdrawn);
    await writeFile(resolve(archive, "daily/2026-01-03.md"), sourceText("2026-01-03", "北京市介绍地方情况。").replace("title: 华为工资与排班", "title: 北京地方情况")); await commit(archive);
    const next = await build("next");
    assert.deepEqual(next.artifacts["lifecycle.json.gz"].states.entities.find((row) => row.id === huawei.id), dormant);
    await accept(next);
    const restored = await build("restored", await review(next, "restore", [{ path, operation: "restore" }]));
    assert.equal(restored.artifacts["lifecycle.json.gz"].states.entities.find((row) => row.id === huawei.id).state, "active");
    assert.equal(restored.artifacts["lifecycle.json.gz"].sourceStates[path], undefined);
    assert.ok(restored.artifacts["kg.json"].entities.some((row) => row.id === huawei.id));
    const before = await acceptedBytes(directory);
    await rm(resolve(archive, path)); await commit(archive);
    await assert.rejects(build("unreviewed"), /review/u);
    assert.deepEqual(await acceptedBytes(directory), before);
  });
});

test("full current rebuild recomputes the global 91-to-90 place cap from an accepted checkpoint", async () => {
  await workspace(async ({ archive, build, accept, review }) => {
    const seed = await build("seed"); await accept(seed);
    assert.equal(seed.artifacts["kg.json"].eventRelations.length, 0);
    const path = "daily/2026-02-10.md"; await rm(resolve(archive, path)); await commit(archive);
    const withdrawn = await build("withdrawn", await review(seed, "delete", [{ path, operation: "delete" }]));
    const kg = withdrawn.artifacts["kg.json"];
    assert.equal(kg.events.length, 90); assert.equal(kg.eventRelations.length, 89);
    const left = kg.events.find((row) => row.date === "2026-02-09"); const right = kg.events.find((row) => row.date === "2026-02-11");
    assert.ok(kg.eventRelations.some((row) => row.from === left.id && row.to === right.id));
  }, async (archive) => {
    await rm(resolve(archive, "daily"), { recursive: true }); await mkdir(resolve(archive, "daily"));
    for (let index = 0; index < 91; index += 1) {
      const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
      await writeFile(resolve(archive, `daily/${date}.md`), `---\ntitle: 美国情况\npublished: true\ndateCreated: ${date}T00:00:00Z\n---\n\n美国介绍情况。\n`);
    }
  });
});

test("fake trust flags, arbitrary local receipts and corrupt audit read-back fail closed", async () => {
  await workspace(async ({ directory, archive, build, accept, load, store }) => {
    await assert.rejects(buildAcceptedCandidate(directory, { checkpoint: { verified: true }, source: archive, store }), /checkpoint|capability|trust/u);
    const seed = await build("seed"); await accept(seed);
    const before = await acceptedBytes(directory);
    await assert.rejects(build("flag", { verified: true }), /trust flags/u);
    const capability = await load();
    const corruptStore = { async readBundle(options) {
      const result = await store.readBundle(options); const files = result.files;
      const lifecycle = structuredClone(seed.artifacts["lifecycle.json.gz"]); lifecycle.states.news[0].state = "dormant";
      files.set("lifecycle.json.gz", gzipSync(jsonBytes(lifecycle)));
      return result;
    } };
    await assert.rejects(build("corrupt", { checkpoint: capability, store: corruptStore }), /receipt mismatch/u);
    const path = resolve(directory, "data/accepted-release.json"); const original = await readFile(path);
    const forged = JSON.parse(original); forged.inventories.sourceStatesHash = "f".repeat(64);
    forged.releaseId = acceptedReleaseIdentity(forged);
    validateAcceptedReleaseStructure(forged); // Internally consistent hashes are not Git authority.
    await writeFile(path, jsonBytes(forged));
    await assert.rejects(build("forged"), /checkpoint|accepted|Git|worktree/u);
    assert.deepEqual(await acceptedBytes(directory), before);
  });
});

test("missing current raw Git bytes fail, while missing ancestor-only bytes are not replayed", async () => {
  await workspace(async ({ directory, archive, build, accept, review }) => {
    const seed = await build("seed"); await accept(seed);
    const path = "daily/2026-01-01.md"; const file = resolve(archive, path);
    const oldOid = (await git(archive, ["rev-parse", `HEAD:${path}`])).stdout.trim();
    await writeFile(file, sourceText("2026-01-01", "北京市华为介绍工资与排班改革情况。")); await commit(archive);
    const revised = await build("revised", await review(seed, "revise", [{ path, operation: "revise" }])); await accept(revised);
    await rm(resolve(archive, ".git/objects", oldOid.slice(0, 2), oldOid.slice(2)));
    const before = await acceptedBytes(directory);
    assert.equal((await build("reuse-without-ancestor" )).noop, true);
    const currentOid = (await git(archive, ["rev-parse", `HEAD:${path}`])).stdout.trim();
    await rm(resolve(archive, ".git/objects", currentOid.slice(0, 2), currentOid.slice(2)));
    await assert.rejects(build("missing-current"), /historical source blob|Git batch|Git object/u);
    assert.deepEqual(await acceptedBytes(directory), before);
  });
});

test("final publication and verification gates reject accepted/config/source/review races", async () => {
  await workspace(async ({ directory, archive, build, accept, review, load, store }) => {
    const seed = await build("seed"); await accept(seed);
    const path = "daily/2026-01-01.md";
    const options = await review(seed, "withdraw", [{ path, operation: "retract" }]);
    const reviewBytes = await readFile(options.sourceReview);
    await assert.rejects(build("review-race", options, { beforePublish: () => writeFile(options.sourceReview, "{}") }), /review changed/u);
    await writeFile(options.sourceReview, reviewBytes);
    const stateFile = resolve(directory, "data/archive-state.json"); const state = await readFile(stateFile);
    await assert.rejects(build("accepted-race", options, { beforePublish: () => writeFile(stateFile, Buffer.concat([state, Buffer.from("\n")])) }), /accepted|changed/u);
    await writeFile(stateFile, state);
    await assert.rejects(build("head-race", options, { beforePublish: () => commit(archive) }), /HEAD changed/u);
    const valid = await build("valid", options);
    const configPath = resolve(directory, "data/news-overrides.json"); const config = await readFile(configPath);
    await assert.rejects(verifyAcceptedCandidate(directory, valid.output, { source: archive, checkpoint: await load(), store }, { beforeVerifyReturn: () => writeFile(configPath, Buffer.concat([config, Buffer.from("\n")])) }), /configuration|changed/u);
    await writeFile(configPath, config);
    for (const name of ["review-race", "accepted-race", "head-race"]) await assert.rejects(readFile(resolve(directory, `work/accepted/${name}/manifest.json`)), /ENOENT/u);
  });
});

test("standalone checkpoint verifier rejects self-rehashed materialization", async () => {
  await workspace(async ({ directory, archive, build, load, store }) => {
    const seed = await build("seed");
    const lifecycle = structuredClone(seed.artifacts["lifecycle.json.gz"]); lifecycle.states.news[0].state = "dormant";
    const content = gzipSync(jsonBytes(lifecycle), { level: 6 });
    await writeFile(resolve(seed.output, "lifecycle.json.gz"), content);
    const manifest = structuredClone(seed.manifest); manifest.artifacts["lifecycle.json.gz"] = { sha256: sha256(content), bytes: content.length };
    const payload = { ...manifest }; delete payload.bundleId; manifest.bundleId = hash(payload);
    await writeFile(resolve(seed.output, "manifest.json"), jsonBytes(manifest));
    assert.equal((await verifyCandidateBundle(seed.output)).manifest.bundleId, manifest.bundleId);
    await assert.rejects(verifyAcceptedCandidate(directory, seed.output, { source: archive, checkpoint: await load(), store }), /lifecycle.json.gz differs from historical replay/u);
  });
});

test("legacy checkpoint migrates to explicit news identities and continuation preserves raw support history", async () => {
  await workspace(async ({ directory, archive, build, accept, load, store }) => {
    const seed = await build("identity-seed"); const original = await accept(seed);
    assert.equal(Object.hasOwn(original.manifest.configuration, "identityRegistry"), false);
    const raw = seed.artifacts["kg.json"]; const news = seed.artifacts["news.json"];
    const huawei = raw.entities.find((row) => row.label === "华为"); assert.ok(huawei);
    const event = raw.events.find((row) => row.entityIds.includes(huawei.id));
    const item = news.news.find((row) => row.id === event.newsId);
    const config = { schemaVersion: 1, scope: "news_scoped_extraction_assignment", identities: [{ id: "identity-huawei-reviewed", type: huawei.type, label: "华为（审查身份）", status: "active", reason: "Fixture review of selected news subject", reviewedAt: generatedAt }], assignments: [{ id: assignedEntityAssertionId(event.id, huawei.id), newsId: item.id, rawEntityId: huawei.id, fragmentHash: item.fragment.contentHash, inputHash: buildReviewedIdentityInputHash(item), identityId: "identity-huawei-reviewed", reason: "Explicitly reviewed this one news assignment", reviewedAt: generatedAt }] };
    await writeFile(resolve(directory, "data/entity-identities.json"), jsonBytes(config));
    const code = await commit(directory, ["data/entity-identities.json"]); await git(directory, ["update-ref", "refs/remotes/origin/main", code]);
    await assert.rejects(build("identity-unreviewed"), /explicit migration required/u);
    const preview = await previewAcceptedMigration(directory, { source: archive, checkpoint: await load(), store, generatedAt });
    assert.equal(Object.hasOwn(preview.reviewBinding.from.configuration, "identityRegistry"), false);
    assert.ok(preview.reviewBinding.to.configuration.identityRegistry);
    assert.equal(preview.diff.identity.registry.summary.added, 2);
    const migrationReview = resolve(directory, "identity.review.json");
    await writeFile(migrationReview, jsonBytes({ ...preview.reviewBinding, reviewedAt: generatedAt, reason: "Review exact news-scoped identity and resolved chronology diff" }));
    const next = await build("identity-migrated", { migrationReview });
    const { identityResolution, ...unmodifiedRaw } = next.artifacts["kg.json"];
    assert.deepEqual(unmodifiedRaw, raw);
    assert.equal(identityResolution.overlay.assignments.length, 1);
    for (const collection of ["assertions", "supports", "observations", "evidence"]) assert.deepEqual(next.artifacts["provenance.json.gz"][collection], seed.artifacts["provenance.json.gz"][collection]);
    assert.equal((await verifyAcceptedCandidate(directory, next.output, { source: archive, checkpoint: await load(), store })).mode, "migration");
    await accept(next);
    assert.equal((await build("identity-noop")).noop, true);
    await writeFile(resolve(archive, "daily/2026-01-04.md"), sourceText("2026-01-04")); await commit(archive);
    const added = await build("identity-append");
    assert.equal(added.artifacts["kg.json"].identityResolution.overlay.assignments.length, 1);
    assert.equal(added.artifacts["kg.json"].events.length, raw.events.length + 1);
  });
});

test("accepted action supports survive qualifier correction, reviewed withdrawal and restoration without fact fusion", async () => {
  await workspace(async ({ archive, build, accept, review }) => {
    const path = "daily/2026-01-01.md";
    const seed = await build("action-seed"); await accept(seed);
    const oldEvent = seed.artifacts["kg.json"].events.find((event) => event.actionAssessment.assignments.some((row) => row.modality === "planned"));
    assert.ok(oldEvent);
    const actionAssertion = (candidate, eventId) => candidate.artifacts["provenance.json.gz"].assertions.find((row) => row.subject === eventId && row.predicate === "assigned_reported_action");
    const planned = actionAssertion(seed, oldEvent.id); assert.equal(planned.object.modality, "planned");
    const body = sourceText("2026-01-01", "北京市甲铁路项目已经开工建设，施工方继续介绍劳动与工资安排。");
    await writeFile(resolve(archive, path), body); await commit(archive);
    await assert.rejects(build("unreviewed-action-correction"), /review/u);
    const corrected = await build("action-corrected", await review(seed, "action-correction", [{ path, operation: "revise" }]));
    const reported = actionAssertion(corrected, oldEvent.id);
    assert.equal(reported.object.modality, "reported"); assert.notEqual(reported.id, planned.id);
    assert.equal(corrected.artifacts["lifecycle.json.gz"].states.assertions.find((row) => row.id === planned.id).state, "dormant");
    assert.deepEqual(corrected.artifacts["diff.json"].actions.changedNewsIds, [oldEvent.newsId]);
    const report = JSON.parse(corrected.acceptedFiles.get("data/review/ontology-candidates.json"));
    assert.equal(report.actionAssessments.statusCounts.applicable, 2);
    assert.equal(report.actionAssessments.directClassNewsCounts["action-engineering"], 2);
    await accept(corrected);
    await rm(resolve(archive, path)); await commit(archive);
    const withdrawn = await build("action-withdrawn", await review(corrected, "withdraw-action", [{ path, operation: "retract" }]));
    assert.equal(withdrawn.artifacts["lifecycle.json.gz"].states.assertions.find((row) => row.id === reported.id).state, "dormant");
    assert.equal(withdrawn.artifacts["kg.json"].events.filter((row) => row.actionAssessment.status === "applicable").length, 1);
    assert.equal(withdrawn.artifacts["provenance.json.gz"].assertions.filter((row) => row.predicate === "assigned_reported_action").length, 1);
    await accept(withdrawn);
    await writeFile(resolve(archive, path), body); await commit(archive);
    const restored = await build("action-restored", await review(withdrawn, "restore-action", [{ path, operation: "restore" }]));
    assert.equal(actionAssertion(restored, oldEvent.id).id, reported.id);
    assert.equal(restored.artifacts["lifecycle.json.gz"].states.assertions.find((row) => row.id === reported.id).state, "active");
    assert.equal(restored.artifacts["provenance.json.gz"].assertions.every((row) => row.epistemicScope === "extraction_assignment"), true);
  }, async (archive) => {
    await writeFile(resolve(archive, "daily/2026-01-01.md"), sourceText("2026-01-01", "北京市甲铁路项目计划明年开工建设，施工方继续介绍劳动与工资安排。"));
    await writeFile(resolve(archive, "daily/2026-01-02.md"), sourceText("2026-01-02", "上海市乙铁路项目已经开工建设，施工方继续介绍劳动与工资安排。"));
  });
});

test("action-rule semantic migration binds exact qualifier diff and cannot silently rewrite legacy domains", async () => {
  await workspace(async ({ directory, archive, build, accept, load, store }) => {
    const seed = await build("action-migration-seed"); await accept(seed);
    const patternsPath = resolve(directory, "data/extraction-patterns.json");
    const patterns = JSON.parse(await readFile(patternsPath, "utf8"));
    patterns.version = "4.2.1";
    patterns.actionExtraction.rules.find((rule) => rule.template === "engineering_lifecycle").predicates = ["投产"];
    await writeFile(patternsPath, `${JSON.stringify(patterns, null, 2)}\n`);
    await run(directory, process.execPath, ["scripts/compile-ontology.mjs"]);
    const code = await commit(directory, ["data"]); await git(directory, ["update-ref", "refs/remotes/origin/main", code]);
    await assert.rejects(build("action-unreviewed-semantic"), /explicit migration required/u);
    const preview = await previewAcceptedMigration(directory, { source: archive, checkpoint: await load(), store, generatedAt });
    const migrationReview = resolve(directory, "action-semantic.review.json");
    await writeFile(migrationReview, jsonBytes({ ...preview.reviewBinding, reviewedAt: generatedAt, reason: "Review narrowing of engineering extraction predicates, preserving legacy domains and raw identity assignments" }));
    const migrated = await build("action-reviewed-semantic", { migrationReview });
    assert.equal(migrated.mode, "migration");
    assert.equal(migrated.artifacts["diff.json"].actions.records.summary.changed, 2);
    assert.deepEqual(migrated.artifacts["kg.json"].events.map(({ id, type, entityIds, topicEvidence }) => ({ id, type, entityIds, topicEvidence })), seed.artifacts["kg.json"].events.map(({ id, type, entityIds, topicEvidence }) => ({ id, type, entityIds, topicEvidence })));
    assert.equal(migrated.artifacts["kg.json"].events.every((row) => row.actionAssessment.status === "undetermined"), true);
    assert.equal((await verifyAcceptedCandidate(directory, migrated.output, { source: archive, checkpoint: await load(), store })).mode, "migration");
    await accept(migrated); assert.equal((await build("action-migration-noop")).noop, true);
  }, async (archive) => {
    for (const day of ["2026-01-01", "2026-01-02"]) await writeFile(resolve(archive, `daily/${day}.md`), sourceText(day, "北京市甲铁路项目计划明年开工建设，施工方继续介绍劳动与工资安排。"));
  });
});

test("action qualifier rollback reports the restored assessment and preserves forward support history", async () => {
  await workspace(async ({ directory, archive, build, accept, load, store, review }) => {
    const path = "daily/2026-01-01.md";
    const seed = await build("action-rollback-seed"); const target = await accept(seed);
    const event = seed.artifacts["kg.json"].events.find((row) => row.actionAssessment.assignments.some((assignment) => assignment.modality === "planned"));
    assert.ok(event);
    const assertion = (candidate) => candidate.artifacts["provenance.json.gz"].assertions.find((row) => row.subject === event.id && row.predicate === "assigned_reported_action");
    await writeFile(resolve(archive, path), sourceText("2026-01-01", "北京市甲铁路项目已经开工建设，施工方继续介绍劳动与工资安排。")); await commit(archive);
    const corrected = await build("action-rollback-correction", await review(seed, "action-rollback-correction", [{ path, operation: "revise" }]));
    assert.equal(assertion(corrected).object.modality, "reported"); await accept(corrected);
    const checkpoint = await load();
    const rollbackCheckpoint = await loadAcceptedGitCheckpoint({ root: directory, repository, commit: target.commit, allowAncestor: true });
    const rollbackReview = resolve(directory, "action-rollback.review.json");
    const binding = rollbackReviewBinding(await readVerifiedAcceptedCheckpoint(checkpoint), await readVerifiedAcceptedCheckpoint(rollbackCheckpoint));
    await writeFile(rollbackReview, jsonBytes({ ...binding, reviewedAt: generatedAt, reason: "Restore the accepted planned-action qualifier and retain the corrected assertion history" }));
    const away = `${archive}-unavailable`; await rename(archive, away);
    try {
      const options = { checkpoint, rollbackCheckpoint, rollbackReview, store, output: "work/accepted/action-rollback" };
      const restored = await buildAcceptedRollback(directory, options);
      const actions = restored.artifacts["diff.json"].actions;
      assert.deepEqual(actions.changedNewsIds, [event.newsId]);
      assert.equal(actions.records.summary.changed, 1);
      assert.deepEqual(actions.before, corrected.artifacts["diff.json"].actions.after);
      assert.deepEqual(actions.after, seed.artifacts["diff.json"].actions.after);
      assert.equal(actions.assessmentsHash, seed.artifacts["diff.json"].actions.assessmentsHash);
      assert.equal(assertion(restored).id, assertion(seed).id);
      const states = restored.artifacts["lifecycle.json.gz"].states.assertions;
      assert.equal(states.find((row) => row.id === assertion(seed).id).state, "active");
      assert.equal(states.find((row) => row.id === assertion(corrected).id).state, "dormant");
      assert.equal((await verifyAcceptedRollback(directory, restored.output, options)).freshSourceReplay, false);
      assert.deepEqual(JSON.parse(restored.acceptedFiles.get("data/review/ontology-candidates.json")).actionAssessments, actions.after);
      await rename(away, archive);
      await git(archive, ["checkout", "--detach", restored.manifest.inputs.recipe.archiveCommit]);
      await accept(restored);
      assert.equal((await build("action-after-rollback-noop")).noop, true);
    } finally {
      try { await rename(away, archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }, async (archive) => {
    await writeFile(resolve(archive, "daily/2026-01-01.md"), sourceText("2026-01-01", "北京市甲铁路项目计划明年开工建设，施工方继续介绍劳动与工资安排。"));
  });
});
