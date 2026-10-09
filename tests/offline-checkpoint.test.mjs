import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { createOfflineCheckpointStore } from "../scripts/lib/offline-checkpoint-store.mjs";
import { verifyFailedBuildRecovery } from "../scripts/lib/actions-build-recovery.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "offline-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = ["diff.json", "kg.json", "lifecycle.json.gz", "news.json", "provenance.json.gz", "source-review.json"];
  const bytes = Buffer.from("null\n"); const binding = { bytes: bytes.length, sha256: sha256(bytes) };
  const payload = { schemaVersion: 1, kind: "offline-candidate", artifacts: Object.fromEntries(names.map((name) => [name, binding])) };
  const manifest = { ...payload, bundleId: sha256(canonicalJson(payload)) };
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  const receipt = { bundleId: manifest.bundleId, manifestSha256: sha256(manifestBytes), assets: Object.fromEntries(names.map((name) => [name, binding])) };
  receipt.assets["manifest.json"] = { bytes: manifestBytes.length, sha256: sha256(manifestBytes) };
  await Promise.all(names.map((name) => writeFile(join(directory, name), bytes)));
  await writeFile(join(directory, "manifest.json"), manifestBytes);
  return { directory, receipt, store: createOfflineCheckpointStore({ directory, receipt }) };
}
test("offline checkpoint verifies exact receipt and independent repeated reads", async (t) => {
  const { store, receipt } = await fixture(t);
  const first = await store.readBundle({ receipt });
  assert.equal(first.files.size, 7);
  first.files.get("kg.json").fill(0);
  assert.equal((await store.readBundle({ receipt })).files.get("kg.json").toString(), "null\n");
  await assert.rejects(store.readBundle({ receipt: { ...receipt, releaseId: 99 } }));
});
test("offline checkpoint rejects changed bytes between build and replay", async (t) => {
  const { store, receipt, directory } = await fixture(t);
  await store.readBundle({ receipt });
  await writeFile(join(directory, "kg.json"), "true\n");
  await assert.rejects(store.readBundle({ receipt }));
});
test("offline checkpoint rejects extra files and symlinks", async (t) => {
  const { store, receipt, directory } = await fixture(t);
  await writeFile(join(directory, "credential"), "fixture");
  await assert.rejects(store.readBundle({ receipt }));
  await rm(join(directory, "credential")); await rm(join(directory, "kg.json"));
  await symlink("news.json", join(directory, "kg.json"));
  await assert.rejects(store.readBundle({ receipt }));
});
test("offline checkpoint rejects receipt-matching but inconsistent manifest", async (t) => {
  const { receipt, directory } = await fixture(t);
  const content = Buffer.from('{}\n');
  await writeFile(join(directory, "manifest.json"), content);
  receipt.manifestSha256 = sha256(content); receipt.assets["manifest.json"] = { bytes: content.length, sha256: sha256(content) };
  await assert.rejects(createOfflineCheckpointStore({ directory, receipt }).readBundle({ receipt }));
});

function recoveryFixture() {
  const failure = { runId: 1, headSha: "a".repeat(40), reconstructJobId: 2 };
  const scope = { bundleId: "b".repeat(64), releaseId: 3 };
  const run = { id: 1, head_sha: failure.headSha, run_attempt: 1, event: "workflow_dispatch", status: "completed", conclusion: "failure", path: ".github/workflows/sync-archive.yml", head_branch: "fix/actions-audit-successor-20261009" };
  const jobs = { total_count: 5, jobs: [{ id: 2, name: "reconstruct", status: "completed", conclusion: "failure" }, ...["upload", "sync", "release-sync", "notify-sync-failure"].map((name) => ({ name, status: "completed", conclusion: "skipped", steps: [] }))] };
  const state = { run, jobs, refs: [], assets: [], calls: [] };
  const api = async (path, options = {}) => {
    assert.equal(options.method ?? "GET", "GET"); state.calls.push(path);
    if (path.includes("/jobs?")) return jobs;
    if (path.startsWith("/actions/")) return run;
    if (path.startsWith("/git/")) return state.refs;
    return state.assets;
  };
  return { api, failure, scope, state };
}
test("failed read-only build recovery retains ordinal and only performs reads", async () => {
  const fixture = recoveryFixture();
  assert.equal((await verifyFailedBuildRecovery(fixture)).successorOrdinal, 1);
  assert.equal(fixture.state.calls.length, 4);
});
for (const [name, mutate] of [
  ["rerun", (s) => { s.run.run_attempt = 2; }],
  ["unknown result", (s) => { s.run.status = "in_progress"; }],
  ["writer started", (s) => { s.jobs.jobs[1].conclusion = "failure"; }],
  ["partial jobs", (s) => { s.jobs.total_count = 6; }],
  ["existing authority", (s) => { s.refs.push({ ref: "occupied" }); }],
  ["existing asset", (s) => { s.assets.push({ id: 1 }); }],
]) test(`failed build recovery rejects ${name}`, async () => {
  const fixture = recoveryFixture(); mutate(fixture.state);
  await assert.rejects(verifyFailedBuildRecovery(fixture));
});
