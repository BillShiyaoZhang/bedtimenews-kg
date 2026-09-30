import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { sourceInventory, assertSafeCandidateSources, assertCandidateOutput, assertCandidateBudget, buildCandidate, verifyCandidate } from "../scripts/lib/candidate-run.mjs";
import { canonicalJson, sha256, verifyCandidateBundle } from "../scripts/lib/candidate-bundle.mjs";
const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));
const timestamp = "2026-01-02T00:00:00Z";
const run = (cwd, command, args) => execFile(command, args, { cwd, maxBuffer: 2 * 1024 * 1024 });
async function withWorkspace(callback) {
  const directory = await mkdtemp(resolve(tmpdir(), "candidate-run-"));
  try {
    await cp(resolve(root, "scripts"), resolve(directory, "scripts"), { recursive: true });
    await cp(resolve(root, "app/lib"), resolve(directory, "app/lib"), { recursive: true });
    await mkdir(resolve(directory, "data/generated"), { recursive: true });
    await mkdir(resolve(directory, "data/processed"));
    for (const path of ["ontology-source.json", "ontology.json", "extraction-patterns.json", "extraction-rules.json", "news-overrides.json"]) await cp(resolve(root, "data", path), resolve(directory, "data", path));
    const archive = resolve(directory, "archive");
    await mkdir(resolve(archive, "daily"), { recursive: true });
    for (const day of ["01", "02"]) await writeFile(resolve(archive, `daily/2026-01-${day}.md`), `---\ntitle: 华为工资与排班\npublished: true\ndateCreated: 2026-01-${day}T00:00:00Z\n---\n\n北京市华为介绍工资与排班情况。\n`);
    await writeFile(resolve(archive, "daily/excluded.md"), "---\ntitle: Excluded fixture\npublished: false\n---\nUnpublished source container.\n");
    await run(archive, "git", ["init", "-q"]); await run(archive, "git", ["add", "."]);
    await run(archive, "git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "candidate fixture"]);
    await run(directory, process.execPath, ["scripts/update-kg.mjs", "--bootstrap", "--source", archive, "--include", "daily"]);
    await callback({ directory, archive });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const acceptedPaths = ["data/generated/kg.json", "data/processed/news.json", "data/archive-state.json"];
const acceptedBytes = (directory) => Promise.all(acceptedPaths.map((path) => readFile(resolve(directory, path), "utf8")));

test("candidate CLI builds, reuses, validates and diffs real complete bundles without accepted writes", async () => {
  await withWorkspace(async ({ directory, archive }) => {
    const before = await acceptedBytes(directory);
    const args = ["scripts/build-candidate.mjs", "--source", archive, "--output", "work/first", "--generated-at", timestamp];
    const initial = JSON.parse((await run(directory, process.execPath, args)).stdout.trim());
    assert.equal(initial.kind, "offline-candidate"); assert.equal(initial.news, 2); assert.ok(initial.supports > 0);
    const repeated = JSON.parse((await run(directory, process.execPath, args)).stdout.trim());
    assert.equal(repeated.bundleId, initial.bundleId); assert.equal(repeated.existing, true);
    const verified = await run(directory, process.execPath, ["scripts/validate-candidate.mjs", "work/first", "--source", archive]);
    assert.match(verified.stdout, /Verified offline candidate/u);
    const first = await verifyCandidateBundle(resolve(directory, "work/first"));
    assert.equal(first.artifacts["diff.json"].provenance.available, false);
    assert.equal(first.artifacts["diff.json"].graph.summary.added, 0);
    assert.equal(first.artifacts["diff.json"].graph.summary.removed, 0);
    await run(directory, process.execPath, ["scripts/build-candidate.mjs", "--source", archive, "--output", "work/second", "--baseline", "work/first", "--generated-at", timestamp]);
    await run(directory, process.execPath, ["scripts/validate-candidate.mjs", "work/second", "--baseline", "work/first", "--source", archive]);
    const second = await verifyCandidateBundle(resolve(directory, "work/second"));
    assert.equal(second.artifacts["diff.json"].provenance.available, true);
    assert.equal(second.artifacts["diff.json"].provenance.diff.summary.changed, 0);
    assert.equal(second.artifacts["diff.json"].provenance.diff.summary.added, 0);
    const unchanged = await run(directory, process.execPath, ["scripts/update-kg.mjs", "--source", archive, "--include", "daily"]);
    assert.match(unchanged.stdout, /Already current/u);
    assert.deepEqual(await acceptedBytes(directory), before);
  });
});

test("candidate CLI refuses modified, deleted and unreviewed duplicate source input", async () => {
  await withWorkspace(async ({ directory, archive }) => {
    const before = await acceptedBytes(directory);
    const path = resolve(archive, "daily/2026-01-01.md"); const raw = await readFile(path, "utf8");
    await writeFile(path, raw + "\n<!-- Changed outside the accepted fragment -->\n");
    await assert.rejects(run(directory, process.execPath, ["scripts/build-candidate.mjs", "--source", archive, "--output", "work/rejected"]), /withdrawal\/review migration/u);
    await writeFile(path, raw);
    await cp(path, resolve(archive, "daily/copy.md"));
    await assert.rejects(run(directory, process.execPath, ["scripts/build-candidate.mjs", "--source", archive]), /withdrawal\/review migration/u);
    await rm(resolve(archive, "daily/copy.md")); await rm(path);
    await assert.rejects(run(directory, process.execPath, ["scripts/build-candidate.mjs", "--source", archive]), /withdrawal\/review migration/u);
    assert.deepEqual(await acceptedBytes(directory), before);
  });
});

test("candidate source gate rejects duplicate new additions and output overlap", () => {
  const a = "a".repeat(64); const b = "b".repeat(64);
  assert.throws(() => assertSafeCandidateSources({ "daily/old.md": a }, { "daily/old.md": a, "daily/new1.md": b, "daily/new2.md": b }), /Duplicate additions/u);
  assert.throws(() => assertCandidateOutput(root, resolve(root, "data/candidate"), resolve(root, "sources/archive")), /ignored work/u);
  assert.throws(() => assertCandidateOutput(root, root, resolve(root, "sources/archive")), /ignored work/u);
});

test("standalone candidate verifier rejects damaged artifacts and changed active configs", async () => {
  await withWorkspace(async ({ directory, archive }) => {
    await run(directory, process.execPath, ["scripts/build-candidate.mjs", "--source", archive, "--output", "work/first", "--generated-at", timestamp]);
    const path = resolve(directory, "work/first/provenance.json.gz"); const original = await readFile(path);
    await writeFile(path, "{}\n");
    await assert.rejects(run(directory, process.execPath, ["scripts/validate-candidate.mjs", "work/first", "--source", archive]), /hash\/size mismatch/u);
    await writeFile(path, original);
    await writeFile(resolve(directory, "data/ontology.json"), (await readFile(resolve(directory, "data/ontology.json"), "utf8")) + " ");
    await assert.rejects(run(directory, process.execPath, ["scripts/validate-candidate.mjs", "work/first", "--source", archive]), /stale or hand-edited/u);
  });
});


test("candidate storage budgets fail closed without dropping evidence", () => {
  assert.doesNotThrow(() => assertCandidateBudget({ artifacts: { "provenance.json.gz": { bytes: 64 * 1024 * 1024 } } }));
  assert.throws(() => assertCandidateBudget({ artifacts: { "provenance.json.gz": { bytes: 64 * 1024 * 1024 + 1 } } }), /64 MiB/u);
  assert.throws(() => assertCandidateBudget({ artifacts: { "provenance.json.gz": { bytes: 60 * 1024 * 1024 }, "kg.json": { bytes: 70 * 1024 * 1024 } } }), /128 MiB/u);
});


test("candidate output never enters public/build roots and source aliases cannot evade isolation", async () => {
  for (const path of ["public/candidate", "out/candidate", "dist/candidate", "build/candidate", ".next/candidate"]) assert.throws(() => assertCandidateOutput(root, resolve(root, path), resolve(root, "sources/archive")), /ignored work/u);
  await withWorkspace(async ({ directory, archive }) => {
    const alias = resolve(directory, "source-alias"); await symlink(archive, alias);
    await assert.rejects(sourceInventory(alias, ["daily"]), /symlink/u);
    await assert.rejects(run(directory, process.execPath, ["scripts/build-candidate.mjs", "--source", alias, "--output", resolve(archive, "candidate")]), /symlink/u);
  });
});

function rehashManifest(manifest) {
  const payload = { schemaVersion: manifest.schemaVersion, kind: manifest.kind, artifacts: manifest.artifacts, inputs: manifest.inputs, versions: manifest.versions };
  return { ...manifest, bundleId: sha256(canonicalJson(payload)) };
}

test("semantic verification rejects self-rehashed version labels and KG timestamps", async () => {
  await withWorkspace(async ({ directory, archive }) => {
    await run(directory, process.execPath, ["scripts/build-candidate.mjs", "--source", archive, "--output", "work/first", "--generated-at", timestamp]);
    const path = resolve(directory, "work/first/manifest.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    const fakeVersion = structuredClone(original); fakeVersion.versions.ontology = "99.0.0";
    await writeFile(path, canonicalJson(rehashManifest(fakeVersion)) + "\n");
    await assert.rejects(run(directory, process.execPath, ["scripts/validate-candidate.mjs", "work/first", "--source", archive]), /version labels differ/u);
    const kgPath = resolve(directory, "work/first/kg.json"); const kg = JSON.parse(await readFile(kgPath, "utf8"));
    kg.generatedAt = "2099-01-01T00:00:00Z"; const bytes = canonicalJson(kg) + "\n"; await writeFile(kgPath, bytes);
    const fakeTime = structuredClone(original); fakeTime.artifacts["kg.json"] = { bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
    await writeFile(path, canonicalJson(rehashManifest(fakeTime)) + "\n");
    await assert.rejects(run(directory, process.execPath, ["scripts/validate-candidate.mjs", "work/first", "--source", archive]), /timestamp differs/u);
  });
});


test("preparation binds parsed configs and accepted data to the exact pre-read byte snapshot", async () => {
  await withWorkspace(async ({ directory, archive }) => {
    const path = resolve(directory, "data/generated/kg.json");
    const before = await readFile(path, "utf8");
    await assert.rejects(buildCandidate(directory, { source: archive, output: "work/race", generatedAt: timestamp }, { afterInputSnapshot: async () => {
      const changed = JSON.parse(before); changed.generatedAt = "2099-01-01T00:00:00Z";
      await writeFile(path, JSON.stringify(changed));
    } }), /inputs changed during preparation/u);
    await assert.rejects(readFile(resolve(directory, "work/race/manifest.json")), /ENOENT/u);
  });
});


test("source files producing no news are rehashed after preparation and before verification success", async () => {
  await withWorkspace(async ({ directory, archive }) => {
    const path = resolve(archive, "daily/excluded.md"); const original = await readFile(path, "utf8");
    await assert.rejects(buildCandidate(directory, { source: archive, output: "work/race", generatedAt: timestamp }, { afterNewsRegeneration: () => writeFile(path, original + "changed during prepare") }), /inventory changed during candidate preparation/u);
    await writeFile(path, original);
    await buildCandidate(directory, { source: archive, output: "work/first", generatedAt: timestamp });
    await assert.rejects(verifyCandidate(directory, "work/first", { source: archive }, { beforeVerifyReturn: () => writeFile(path, original + "changed during verify") }), /inventory changed during candidate verification/u);
  });
});
