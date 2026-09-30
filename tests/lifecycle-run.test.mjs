import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { buildLifecycleCandidate, verifyLifecycleCandidate, assertLifecycleBudget } from "../scripts/lib/lifecycle-run.mjs";
import { sourceInventory } from "../scripts/lib/candidate-run.mjs";
import { canonicalJson, sha256, verifyCandidateBundle } from "../scripts/lib/candidate-bundle.mjs";
const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));
const generatedAt = "2026-01-03T00:00:00Z";
const run = (cwd, command, args) => execFile(command, args, { cwd, maxBuffer: 2 * 1024 * 1024 });
async function commit(archive) {
  await run(archive, "git", ["add", "-A"]);
  await run(archive, "git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture source revision"]);
}
async function workspace(callback, configureArchive) {
  const directory = await mkdtemp(resolve(tmpdir(), "lifecycle-run-"));
  try {
    await cp(resolve(root, "scripts"), resolve(directory, "scripts"), { recursive: true });
    await cp(resolve(root, "app/lib"), resolve(directory, "app/lib"), { recursive: true });
    await mkdir(resolve(directory, "data/generated"), { recursive: true }); await mkdir(resolve(directory, "data/processed"));
    for (const path of ["ontology-source.json", "ontology.json", "extraction-patterns.json", "extraction-rules.json", "news-overrides.json"]) await cp(resolve(root, "data", path), resolve(directory, "data", path));
    const archive = resolve(directory, "archive"); await mkdir(resolve(archive, "daily"), { recursive: true });
    for (const day of ["01", "02"]) await writeFile(resolve(archive, `daily/2026-01-${day}.md`), `---\ntitle: 华为工资与排班\npublished: true\ndateCreated: 2026-01-${day}T00:00:00Z\n---\n\n北京市华为介绍工资与排班情况。\n`);
    await writeFile(resolve(archive, "daily/excluded.md"), "---\ntitle: Excluded\npublished: false\n---\nNot published.\n");
    if (configureArchive) await configureArchive(archive);
    await run(archive, "git", ["init", "-q"]); await commit(archive);
    await run(directory, process.execPath, ["scripts/update-kg.mjs", "--bootstrap", "--source", archive, "--include", "daily"]);
    const build = (name, options = {}, hooks = {}) => buildLifecycleCandidate(directory, { source: archive, output: `work/lifecycle/${name}`, generatedAt, ...options }, hooks);
    const bundle = (name) => verifyCandidateBundle(resolve(directory, "work/lifecycle", name));
    const review = async (baseline, name, decisions) => {
      const before = await bundle(baseline); const current = await sourceInventory(archive, ["daily"], { allowEmpty: true });
      const old = before.artifacts["lifecycle.json.gz"].observedInventory;
      const states = before.artifacts["lifecycle.json.gz"].sourceStates;
      const value = { schemaVersion: 1, baselineBundleId: before.manifest.bundleId, baselineInventoryHash: sha256(canonicalJson(old)), currentInventoryHash: sha256(canonicalJson(current)), reviewedAt: generatedAt, reason: "Fixture reviewed source transition", decisions: decisions.map(({ path, operation }) => ({ path, operation, fromHash: operation === "restore" ? states[path].lastHash : old[path] ?? null, toHash: current[path] ?? null, reason: "Fixture exact review" })) };
      const path = resolve(directory, `${name}.json`); await writeFile(path, JSON.stringify(value, null, 2) + "\n"); return { baseline: `work/lifecycle/${baseline}`, sourceReview: path };
    };
    await callback({ directory, archive, build, bundle, review });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const acceptedPaths = ["data/generated/kg.json", "data/processed/news.json", "data/archive-state.json"];
const accepted = (directory) => Promise.all(acceptedPaths.map((path) => readFile(resolve(directory, path), "utf8")));

test("lifecycle actual CLI revises, deletes and restores source support with scoped history and unchanged accepted data", async () => {
  await workspace(async ({ directory, archive, build, bundle, review }) => {
    const before = await accepted(directory);
    const args = ["scripts/build-lifecycle-candidate.mjs", "--source", archive, "--output", "work/lifecycle/seed", "--generated-at", generatedAt];
    const initial = JSON.parse((await run(directory, process.execPath, args)).stdout.trim());
    assert.equal(initial.news, 2); assert.equal(initial.historyBundles, 0);
    const repeated = JSON.parse((await run(directory, process.execPath, args)).stdout.trim());
    assert.equal(repeated.bundleId, initial.bundleId); assert.equal(repeated.existing, true);
    const seed = await bundle("seed"); const oldNewsId = seed.artifacts["news.json"].news[0].id;
    const path = "daily/2026-01-01.md"; const file = resolve(archive, path); const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("介绍工资与排班情况", "介绍工资与排班改革情况")); await commit(archive);
    await build("revised", await review("seed", "revise", [{ path, operation: "revise" }]));
    const revised = await bundle("revised");
    assert.equal(revised.artifacts["news.json"].news[0].id, oldNewsId);
    assert.notEqual(revised.artifacts["provenance.json.gz"].newsRevisions.find((row) => row.newsId === oldNewsId).id, seed.artifacts["provenance.json.gz"].newsRevisions.find((row) => row.newsId === oldNewsId).id);
    await rm(file); await commit(archive);
    await build("deleted", await review("revised", "delete", [{ path, operation: "delete" }]));
    const deleted = await bundle("deleted");
    assert.equal(deleted.artifacts["news.json"].news.length, 1);
    assert.ok(!deleted.artifacts["kg.json"].entities.some((row) => row.label === "华为"));
    assert.ok(deleted.artifacts["kg.json"].entities.some((row) => row.label === "北京市"));
    const huawei = seed.artifacts["kg.json"].entities.find((row) => row.label === "华为");
    assert.equal(deleted.artifacts["lifecycle.json.gz"].states.entities.find((row) => row.id === huawei.id).state, "dormant");
    assert.equal(deleted.artifacts["lifecycle.json.gz"].sourceStates[path].status, "deleted");
    await writeFile(file, original.replace("介绍工资与排班情况", "介绍工资与排班改革情况")); await commit(archive);
    await build("restored", await review("deleted", "restore", [{ path, operation: "restore" }]));
    const restored = await bundle("restored");
    assert.equal(restored.artifacts["news.json"].news.length, 2);
    assert.deepEqual(restored.artifacts["kg.json"].entities.map((row) => row.id), seed.artifacts["kg.json"].entities.map((row) => row.id));
    assert.equal(restored.artifacts["lifecycle.json.gz"].sourceStates[path], undefined);
    const verified = await run(directory, process.execPath, ["scripts/validate-lifecycle-candidate.mjs", "work/lifecycle/restored", "--source", archive]);
    assert.match(verified.stdout, /4 replayed historical/u);
    assert.deepEqual(await accepted(directory), before);
    await assert.rejects(run(directory, process.execPath, ["scripts/update-kg.mjs", "--source", archive, "--include", "daily"]), /source|Source|review|modified/u);
    assert.deepEqual(await accepted(directory), before);
  });
});

test("retraction excludes still-present exact source bytes and empty active corpus stays replayable", async () => {
  await workspace(async ({ directory, archive, build, bundle, review }) => {
    await build("seed");
    const paths = ["daily/2026-01-01.md", "daily/2026-01-02.md"];
    await build("retracted", await review("seed", "retract", paths.map((path) => ({ path, operation: "retract" }))));
    const result = await bundle("retracted");
    assert.equal(result.artifacts["kg.json"].events.length, 0);
    assert.equal(result.artifacts["kg.json"].entities.length, 0);
    assert.equal(Object.keys(result.artifacts["lifecycle.json.gz"].observedInventory).length, 3);
    await verifyLifecycleCandidate(directory, "work/lifecycle/retracted", { source: archive });
    await build("restored", await review("retracted", "restore", paths.map((path) => ({ path, operation: "restore" }))));
    assert.equal((await bundle("restored")).artifacts["kg.json"].events.length, 2);
  });
});

test("unreviewed absence, dirty sources, boundary migration and Stage C baseline fail closed", async () => {
  await workspace(async ({ directory, archive, build, review }) => {
    await build("seed");
    const path = "daily/2026-01-01.md"; const file = resolve(archive, path); const original = await readFile(file, "utf8");
    await writeFile(file, original + "Changed uncommitted text.");
    await assert.rejects(build("dirty", await review("seed", "dirty-review", [{ path, operation: "revise" }])), /Git|git|snapshot/u);
    await rm(file); await commit(archive);
    await assert.rejects(build("missing", { baseline: "work/lifecycle/seed" }), /review/u);
    await writeFile(file, original.replace("published: true", "published: false")); await commit(archive);
    await assert.rejects(build("boundary", await review("seed", "boundary-review", [{ path, operation: "revise" }])), /identity migration/u);
    await writeFile(file, original); await commit(archive);
    await run(directory, process.execPath, ["scripts/build-candidate.mjs", "--source", archive, "--output", "work/lifecycle/old", "--generated-at", generatedAt]);
    await assert.rejects(build("old-baseline", { baseline: "work/lifecycle/old" }), /Stage C bundles are diff-only/u);
  });
});

test("missing ancestors, forged dormant history and review races never expose candidates", async () => {
  await workspace(async ({ directory, archive, build, review }) => {
    await build("seed");
    const options = await review("seed", "retract", [{ path: "daily/2026-01-01.md", operation: "retract" }]);
    const originalReview = await readFile(options.sourceReview);
    await assert.rejects(build("race", options, { beforePublish: () => writeFile(options.sourceReview, "{}") }), /review changed/u);
    await assert.rejects(readFile(resolve(directory, "work/lifecycle/race/manifest.json")), /ENOENT/u);
    await writeFile(options.sourceReview, originalReview); await build("retracted", options);
    await rename(resolve(directory, "work/lifecycle/seed"), resolve(directory, "work/seed-away"));
    await assert.rejects(verifyLifecycleCandidate(directory, "work/lifecycle/retracted", { source: archive }), /historical bundle unavailable/u);
    await rename(resolve(directory, "work/seed-away"), resolve(directory, "work/lifecycle/seed"));
    const manifestPath = resolve(directory, "work/lifecycle/retracted/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.versions.lifecycle = "99.0.0";
    const payload = { ...manifest }; delete payload.bundleId; manifest.bundleId = sha256(canonicalJson(payload));
    await writeFile(manifestPath, canonicalJson(manifest) + "\n");
    await assert.rejects(verifyLifecycleCandidate(directory, "work/lifecycle/retracted", { source: archive }), /migration/u);
  });
});

test("reviewed withdrawal fully recomputes the 91-to-90 place cap and middle chronology", async () => {
  await workspace(async ({ archive, build, bundle, review }) => {
    await build("seed"); const seed = await bundle("seed");
    assert.equal(seed.artifacts["kg.json"].eventRelations.length, 0);
    const path = "daily/2026-02-10.md"; await rm(resolve(archive, path)); await commit(archive);
    await build("withdrawn", await review("seed", "cap-review", [{ path, operation: "delete" }]));
    const next = await bundle("withdrawn"); const kg = next.artifacts["kg.json"];
    assert.equal(kg.events.length, 90); assert.equal(kg.eventRelations.length, 89);
    const previous = kg.events.find((row) => row.date === "2026-02-09"); const after = kg.events.find((row) => row.date === "2026-02-11");
    assert.ok(kg.eventRelations.some((row) => row.from === previous.id && row.to === after.id));
    assert.ok(next.artifacts["lifecycle.json.gz"].transitions.assertions.some((row) => row.transition === "added"));
  }, async (archive) => {
    await rm(resolve(archive, "daily"), { recursive: true }); await mkdir(resolve(archive, "daily"));
    for (let index = 0; index < 91; index += 1) {
      const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
      await writeFile(resolve(archive, `daily/${date}.md`), `---\ntitle: 美国情况\npublished: true\ndateCreated: ${date}T00:00:00Z\n---\n\n美国介绍情况。\n`);
    }
  });
});

test("removing an episode date anchor revises untouched news dates with corpus-bound provenance", async () => {
  await workspace(async ({ archive, build, bundle, review }) => {
    await build("seed"); const seed = await bundle("seed");
    const old = seed.artifacts["news.json"].news.find((row) => row.title.includes("二"));
    assert.ok(old); assert.equal(old.date, "2019-07-15");
    const path = "daily/episode-three.md"; await rm(resolve(archive, path)); await commit(archive);
    await build("withdrawn", await review("seed", "date-review", [{ path, operation: "delete" }]));
    const next = await bundle("withdrawn"); const changed = next.artifacts["news.json"].news.find((row) => row.id === old.id);
    assert.notEqual(changed.date, old.date);
    const oldPage = seed.artifacts["news.json"].pages.find((row) => row.id === old.pageId);
    const newPage = next.artifacts["news.json"].pages.find((row) => row.id === old.pageId);
    assert.equal(oldPage.contentHash, newPage.contentHash);
    assert.ok(next.artifacts["provenance.json.gz"].dateDerivations.some((row) => row.kind === "corpus_reconciled_publication_date" && row.corpusInventoryHash));
  }, async (archive) => {
    await rm(resolve(archive, "daily"), { recursive: true }); await mkdir(resolve(archive, "daily"));
    for (const [name, number, label, preamble] of [["one", 1, "一", "睡前消息：19/7/12"], ["two", 2, "二", ""], ["three", 3, "三", "睡前消息：19/7/18"]]) {
      await writeFile(resolve(archive, `daily/episode-${name}.md`), `---\ntitle: 【睡前消息${number}】新闻${label}\npublished: true\ndateCreated: 2023-01-24T00:00:00Z\n---\n\n${preamble}\n\n美国介绍工资与劳动情况，这是一段足够长的正文，用来确保新闻片段不会因为长度阈值被过滤掉。\n`);
    }
  });
});

function rehashManifest(manifest) {
  const payload = { ...manifest }; delete payload.bundleId;
  return { ...manifest, bundleId: sha256(canonicalJson(payload)) };
}

test("lifecycle verification rejects forged recipe hashes, unbound recipe fields and self-rehashed dormant states", async () => {
  await workspace(async ({ directory, archive, build }) => {
    await build("seed");
    const file = resolve(directory, "work/lifecycle/seed/manifest.json"); const bytes = await readFile(file, "utf8");
    const original = JSON.parse(bytes);
    for (const corrupt of [
      (manifest) => { manifest.inputs.recipe.sha256 = "0".repeat(64); },
      (manifest) => { manifest.inputs.recipe.unboundExtra = "arbitrary"; },
    ]) {
      const manifest = structuredClone(original); corrupt(manifest);
      await writeFile(file, canonicalJson(rehashManifest(manifest)) + "\n");
      await assert.rejects(verifyLifecycleCandidate(directory, "work/lifecycle/seed", { source: archive }), /recipe hash|unknown or missing fields/u);
    }
    await writeFile(file, bytes);
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const lifecycleFile = resolve(directory, "work/lifecycle/seed/lifecycle.json.gz");
    const lifecycle = JSON.parse(gunzipSync(await readFile(lifecycleFile)).toString("utf8"));
    lifecycle.states.news[0].state = "dormant";
    const changed = gzipSync(Buffer.from(canonicalJson(lifecycle) + "\n")); await writeFile(lifecycleFile, changed);
    const manifest = structuredClone(original); manifest.artifacts["lifecycle.json.gz"] = { bytes: changed.length, sha256: sha256(changed) };
    await writeFile(file, canonicalJson(rehashManifest(manifest)) + "\n");
    await assert.rejects(verifyLifecycleCandidate(directory, "work/lifecycle/seed", { source: archive }), /lifecycle.json.gz differs from historical replay/u);
  });
});

test("historical Git byte loss at final publication and verification gates fails closed", async () => {
  await workspace(async ({ directory, archive, build, review }) => {
    await build("seed"); const sourcePath = "daily/2026-01-01.md"; const path = resolve(archive, sourcePath);
    const oid = (await run(archive, "git", ["rev-parse", `HEAD:${sourcePath}`])).stdout.trim();
    const objectPath = resolve(archive, ".git/objects", oid.slice(0, 2), oid.slice(2)); const originalObject = await readFile(objectPath);
    await writeFile(path, (await readFile(path, "utf8")) + "新的工资说明。\n"); await commit(archive);
    const options = await review("seed", "revised", [{ path: sourcePath, operation: "revise" }]);
    await assert.rejects(build("lost-at-publish", options, { beforePublish: () => rm(objectPath) }), /historical source blob|Git batch|Git object/u);
    await assert.rejects(readFile(resolve(directory, "work/lifecycle/lost-at-publish/manifest.json")), /ENOENT/u);
    await writeFile(objectPath, originalObject);
    await build("revised", options);
    await assert.rejects(verifyLifecycleCandidate(directory, "work/lifecycle/revised", { source: archive }, { beforeVerifyReturn: () => rm(objectPath) }), /historical source blob|Git batch|Git object/u);
    await writeFile(objectPath, originalObject);
    assert.equal((await verifyLifecycleCandidate(directory, "work/lifecycle/revised", { source: archive })).historyBundles, 2);
  });
});

test("final lifecycle gates reject manifest and ancestor directory symlink substitution", async () => {
  for (const kind of ["manifest", "directory"]) await workspace(async ({ directory, archive, build, review }) => {
    await build("seed");
    const options = await review("seed", "retract", [{ path: "daily/2026-01-01.md", operation: "retract" }]);
    const originalPath = resolve(directory, "work/lifecycle/seed", ...(kind === "manifest" ? ["manifest.json"] : []));
    const moved = resolve(directory, kind === "manifest" ? "saved-manifest.json" : "saved-bundle");
    const replace = async () => { await rename(originalPath, moved); await symlink(moved, originalPath); };
    const restore = async () => { await rm(originalPath); await rename(moved, originalPath); };
    await assert.rejects(build("unsafe", options, { beforePublish: replace }), /unsafe|Baseline file type|Baseline directory/u);
    await assert.rejects(readFile(resolve(directory, "work/lifecycle/unsafe/manifest.json")), /ENOENT/u);
    await restore(); await build("retracted", options);
    await assert.rejects(verifyLifecycleCandidate(directory, "work/lifecycle/retracted", { source: archive }, { beforeVerifyReturn: replace }), /unsafe|Baseline file type|Baseline directory/u);
    await restore();
  });
});

test("lifecycle publication and standalone replay use the same audit storage budget", () => {
  const manifest = { artifacts: { "provenance.json.gz": { bytes: 10 }, "lifecycle.json.gz": { bytes: 64 * 1024 * 1024 } } };
  assert.doesNotThrow(() => assertLifecycleBudget(manifest));
  manifest.artifacts["lifecycle.json.gz"].bytes += 1;
  assert.throws(() => assertLifecycleBudget(manifest), /lifecycle audit exceeds/u);
});

test("runtime timezone changes at final publication and verification gates fail closed", async () => {
  const originalTZ = process.env.TZ;
  const changeTZ = () => { process.env.TZ = new Intl.DateTimeFormat().resolvedOptions().timeZone === "America/New_York" ? "Etc/UTC" : "America/New_York"; };
  const restoreTZ = () => { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; };
  try {
    await workspace(async ({ directory, archive, build, review }) => {
      await build("seed");
      const options = await review("seed", "retract", [{ path: "daily/2026-01-01.md", operation: "retract" }]);
      await assert.rejects(build("runtime-race", options, { beforePublish: changeTZ }), /runtime changed/u);
      await assert.rejects(readFile(resolve(directory, "work/lifecycle/runtime-race/manifest.json")), /ENOENT/u);
      restoreTZ(); await build("retracted", options);
      await assert.rejects(verifyLifecycleCandidate(directory, "work/lifecycle/retracted", { source: archive }, { beforeVerifyReturn: changeTZ }), /runtime changed/u);
      restoreTZ();
    });
  } finally { restoreTZ(); }
});
