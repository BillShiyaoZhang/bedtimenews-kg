import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint, assertAcceptedGitCheckpointUnchanged } from "../scripts/lib/accepted-git.mjs";
import { sha256 } from "../scripts/lib/candidate-bundle.mjs";
const execFile = promisify(execFileCallback);
const repository = "fixture/accepted";
const paths = { acceptedState: "data/archive-state.json", acceptedKG: "data/generated/kg.json", acceptedNews: "data/processed/news.json" };
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
async function git(root, args) { return (await execFile("git", ["-C", root, ...args], { env: cleanEnv() })).stdout.trim(); }
async function commit(root, message = "accepted fixture") {
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
async function fixture(callback) {
  const root = await mkdtemp(resolve(tmpdir(), "accepted-git-"));
  try {
    await git(root, ["init", "-q"]); await git(root, ["remote", "add", "origin", `https://github.com/${repository}.git`]);
    for (const [name, path] of Object.entries(paths)) {
      await mkdir(resolve(root, path, ".."), { recursive: true });
      await writeFile(resolve(root, path), JSON.stringify(name === "acceptedState" ? { schemaVersion: 3, acceptedFiles: {}, includedRoots: ["daily"] } : { schemaVersion: "fixture", name }) + "\n");
    }
    const head = await commit(root); await git(root, ["update-ref", "refs/remotes/origin/main", head]);
    await callback({ root, head, load: (options = {}) => loadAcceptedGitCheckpoint({ root, repository, commit: head, ...options }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("trusted loader binds exact accepted Git bytes and ignores edited local receipts", async () => {
  await fixture(async ({ root, head, load }) => {
    const original = await readFile(resolve(root, paths.acceptedKG));
    await writeFile(resolve(root, paths.acceptedKG), "untrusted working tree");
    await writeFile(resolve(root, "data/accepted-release.json"), '{"releaseId":"self-rehashed-local-object"}');
    const capability = await load(); const value = await readVerifiedAcceptedCheckpoint(capability);
    assert.equal(value.commit, head); assert.equal(value.manifest, null);
    assert.equal(value.mainCommit, head); assert.equal(value.allowAncestor, false);
    assert.equal(value.origin.commit, head); assert.deepEqual(value.files.get(paths.acceptedKG), original);
    assert.equal(value.origin.bindings.acceptedKG.sha256, sha256(original));
    value.files.get(paths.acceptedKG).fill(0); value.origin.bytes.acceptedKG.fill(0); value.origin.bindings.acceptedKG.sha256 = "bad";
    const again = await readVerifiedAcceptedCheckpoint(capability);
    assert.deepEqual(again.files.get(paths.acceptedKG), original);
    assert.equal(again.origin.bindings.acceptedKG.sha256, sha256(original));
    assert.equal(again.mainCommit, head); assert.equal(again.allowAncestor, false);
  });
});

test("local lookalikes, booleans and serialized capability copies cannot establish Git trust", async () => {
  await fixture(async ({ load }) => {
    const capability = await load();
    for (const fake of [true, {}, { ...capability }, JSON.parse(JSON.stringify(capability))]) {
      await assert.rejects(readVerifiedAcceptedCheckpoint(fake), /not a capability/u);
      await assert.rejects(assertAcceptedGitCheckpointUnchanged(fake), /not a capability/u);
    }
  });
});

test("checkpoint selection and final gates reject accepted-main movement", async () => {
  await fixture(async ({ root, head, load }) => {
    const capability = await load(); const next = await commit(root, "new main");
    await git(root, ["update-ref", "refs/remotes/origin/main", next]);
    await assert.rejects(assertAcceptedGitCheckpointUnchanged(capability), /exact pinned|ref changed/u);
    await assert.rejects(load(), /exact pinned/u);
    await assert.rejects(load({ allowAncestor: true }), /legacy ancestors/u);
    assert.notEqual(head, next);
  });
});

test("repository identity and malformed or noncommit objects fail closed without leaking remote secrets", async () => {
  await fixture(async ({ root, load }) => {
    await assert.rejects(load({ repository: "another/repo" }), /origin does not identify/u);
    await assert.rejects(load({ commit: "HEAD" }), /40-hex/u);
    const blob = await git(root, ["rev-parse", `HEAD:${paths.acceptedKG}`]);
    await assert.rejects(load({ commit: blob }), /not a commit/u);
    await git(root, ["remote", "set-url", "origin", "https://private-secret@github.com/fixture/accepted.git"]);
    await assert.rejects(load(), (error) => /origin does not identify/u.test(error.message) && !error.message.includes("private-secret"));
  });
});

test("Git environment redirection and replacements do not redefine accepted checkpoint bytes", async () => {
  await fixture(async ({ root, head, load }) => {
    const originalEnv = Object.fromEntries(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].map((key) => [key, process.env[key]]));
    try {
      process.env.GIT_DIR = "/missing/not-this-repository"; process.env.GIT_WORK_TREE = "/missing/worktree"; process.env.GIT_INDEX_FILE = "/missing/index";
      assert.equal((await readVerifiedAcceptedCheckpoint(await load())).commit, head);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    await writeFile(resolve(root, paths.acceptedKG), '{"replaced":true}\n'); const replacement = await commit(root, "fake replacement");
    await git(root, ["replace", head, replacement]);
    const loaded = await readVerifiedAcceptedCheckpoint(await load());
    assert.ok(!loaded.files.get(paths.acceptedKG).toString().includes("replaced"));
  });
});

test("missing original Git output objects cannot be substituted by current working files", async () => {
  await fixture(async ({ root, load }) => {
    const capability = await load();
    const oid = await git(root, ["rev-parse", `HEAD:${paths.acceptedKG}`]);
    await rm(resolve(root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    await assert.rejects(assertAcceptedGitCheckpointUnchanged(capability), /local Git/u);
    await assert.rejects(load(), /local Git/u);
  });
});

test("unbound schema4 data and symlink Git entries cannot become a bootstrap checkpoint", async () => {
  await fixture(async ({ root, load }) => {
    await writeFile(resolve(root, paths.acceptedState), '{"schemaVersion":4}\n'); const next = await commit(root);
    await git(root, ["update-ref", "refs/remotes/origin/main", next]);
    await assert.rejects(load({ commit: next }), /bootstrap requires legacy/u);
  });
  await fixture(async ({ root, load }) => {
    const { symlink } = await import("node:fs/promises");
    await rm(resolve(root, paths.acceptedKG)); await symlink("../archive-state.json", resolve(root, paths.acceptedKG));
    const next = await commit(root); await git(root, ["update-ref", "refs/remotes/origin/main", next]);
    await assert.rejects(load({ commit: next }), /not regular/u);
  });
});
