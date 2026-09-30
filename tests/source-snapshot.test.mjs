import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { assertGitSourceInventory, readGitSourceHead, readVerifiedGitSource, readVerifiedGitSources } from "../scripts/lib/source-snapshot.mjs";
const execFile = promisify(execFileCallback);
const path = "daily/a.md";
const original = Buffer.from("Original source\n");
const git = (root, args) => execFile("git", ["-C", root, ...args]);
async function commit(root, message = "fixture") {
  await git(root, ["add", "--all"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message]);
  return (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
}
async function withArchive(run) {
  const root = await mkdtemp(resolve(tmpdir(), "source-snapshot-"));
  try {
    await mkdir(resolve(root, "daily"));
    await writeFile(resolve(root, path), original);
    await git(root, ["init", "-q"]);
    await run({ sourceRoot: root, commit: await commit(root), path, expectedHash: sha256(original), inventory: { [path]: sha256(original) }, includedRoots: ["daily"] });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("historical source reader preserves exact original bytes after edits and deletion", async () => {
  await withArchive(async (input) => {
    assert.deepEqual(await readVerifiedGitSource(input), original);
    await writeFile(resolve(input.sourceRoot, path), "replacement\n");
    await commit(input.sourceRoot, "edit");
    assert.deepEqual(await readVerifiedGitSource(input), original);
    await rm(resolve(input.sourceRoot, path));
    await commit(input.sourceRoot, "delete");
    assert.deepEqual(await readVerifiedGitSource(input), original);
  });
});

test("snapshot inventory verifies both complete committed and physical source bytes", async () => {
  await withArchive(async (input) => {
    assert.deepEqual(await assertGitSourceInventory(input), input.inventory);
    await writeFile(resolve(input.sourceRoot, path), "uncommitted bytes\n");
    await assert.rejects(assertGitSourceInventory(input), /worktree source inventory/u);
    await assert.rejects(assertGitSourceInventory({ ...input, inventory: { [path]: sha256("uncommitted bytes\n") } }), /Git source SHA-256/u);
    await writeFile(resolve(input.sourceRoot, path), original);
    await writeFile(resolve(input.sourceRoot, "daily/unpublished.md"), "published: false\n");
    await assert.rejects(assertGitSourceInventory(input), /worktree source inventory/u);
    const next = await commit(input.sourceRoot, "unpublished source");
    await assert.rejects(assertGitSourceInventory({ ...input, commit: next }), /Git source paths/u);
    await assert.rejects(assertGitSourceInventory({ ...input, inventory: { ...input.inventory, "daily/unpublished.md": sha256("published: false\n") } }), /Git source paths/u);
    assert.deepEqual(await assertGitSourceInventory({ ...input, commit: next, inventory: { ...input.inventory, "daily/unpublished.md": sha256("published: false\n") } }), { ...input.inventory, "daily/unpublished.md": sha256("published: false\n") });
  });
});

test("exact Git identity and expected source hash are mandatory", async () => {
  await withArchive(async (input) => {
    for (const invalid of ["HEAD", input.commit.slice(0, 12), `${input.commit}^{commit}`, input.commit.toUpperCase(), "a".repeat(40)]) {
      await assert.rejects(readVerifiedGitSource({ ...input, commit: invalid }), /exact lowercase|unavailable/u);
    }
    await assert.rejects(readVerifiedGitSource({ ...input, expectedHash: sha256("wrong") }), /SHA-256 mismatch/u);
    await assert.rejects(readVerifiedGitSource({ ...input, expectedHash: input.commit }), /expectedHash/u);
    await git(input.sourceRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "tag", "-am", "tag", "fixture-tag"]);
    const tag = (await git(input.sourceRoot, ["rev-parse", "fixture-tag"])).stdout.trim();
    await assert.rejects(readVerifiedGitSource({ ...input, commit: tag }), /not a Git commit/u);
    const tree = (await git(input.sourceRoot, ["rev-parse", `${input.commit}^{tree}`])).stdout.trim();
    await assert.rejects(readVerifiedGitSource({ ...input, commit: tree }), /not a Git commit/u);
  });
});

test("historical source reader rejects traversal, ambiguous paths, missing blobs and trees", async () => {
  await withArchive(async (input) => {
    for (const invalid of ["/etc/passwd", "../daily/a.md", "daily/../a.md", "daily//a.md", "daily/./a.md", "daily\\a.md", "daily/a\0.md", "daily/a\n.md", "daily/a.md:other", ""]) {
      await assert.rejects(readVerifiedGitSource({ ...input, path: invalid }), /logical POSIX/u);
    }
    for (const missing of ["daily/missing.md", "daily/*.md", "daily/A.md"]) await assert.rejects(readVerifiedGitSource({ ...input, path: missing }), /missing exact source/u);
    await assert.rejects(readVerifiedGitSource({ ...input, path: "daily" }), /regular Git blob/u);
    await assert.rejects(readVerifiedGitSource({ ...input, sourceRoot: resolve(input.sourceRoot, "daily") }), /exact Git worktree root/u);
  });
});

test("Git and worktree symlinks fail closed while executable regular blobs are supported", async () => {
  await withArchive(async (input) => {
    await chmod(resolve(input.sourceRoot, path), 0o755);
    const executable = await commit(input.sourceRoot, "executable source");
    assert.deepEqual(await readVerifiedGitSource({ ...input, commit: executable }), original);
    assert.deepEqual(await assertGitSourceInventory({ ...input, commit: executable }), input.inventory);
    await symlink("a.md", resolve(input.sourceRoot, "daily/link.md"));
    await assert.rejects(assertGitSourceInventory({ ...input, commit: executable }), /symlink/u);
    const linked = await commit(input.sourceRoot, "symlink source");
    await assert.rejects(readVerifiedGitSource({ ...input, commit: linked, path: "daily/link.md", expectedHash: sha256("a.md") }), /regular Git blob/u);
    await assert.rejects(assertGitSourceInventory({ ...input, commit: linked }), /symlink/u);
    await symlink(input.sourceRoot, resolve(input.sourceRoot, "alias"));
    await assert.rejects(readVerifiedGitSource({ ...input, sourceRoot: resolve(input.sourceRoot, "alias") }), /symlink/u);
  });
});

test("a missing old blob cannot be replaced by identical current worktree bytes", async () => {
  await withArchive(async (input) => {
    const oid = (await git(input.sourceRoot, ["rev-parse", `${input.commit}:${path}`])).stdout.trim();
    const object = resolve(input.sourceRoot, ".git/objects", oid.slice(0, 2), oid.slice(2));
    const saved = await readFile(object);
    await rm(object);
    await assert.rejects(readVerifiedGitSource(input), /unavailable/u);
    await assert.rejects(assertGitSourceInventory(input), /missing or invalid historical source blob/u);
    await writeFile(object, saved);
    assert.deepEqual(await readVerifiedGitSource(input), original);
  });
});

test("empty snapshots are valid after a committed total deletion", async () => {
  await withArchive(async (input) => {
    await rm(resolve(input.sourceRoot, path));
    const deletedCommit = await commit(input.sourceRoot, "delete final source");
    assert.deepEqual(await assertGitSourceInventory({ ...input, commit: deletedCommit, inventory: {} }), {});
    await assert.rejects(assertGitSourceInventory({ ...input, commit: input.commit, inventory: {} }), /Git source paths/u);
  });
});

test("byte batching handles empty files, binary bytes, Unicode and literal metacharacter paths", async () => {
  await withArchive(async (input) => {
    const inventory = { ...input.inventory };
    const files = new Map([
      ["daily/空白.md", Buffer.alloc(0)],
      ["daily/[literal]*.md", Buffer.from([0, 255, 10, 13, 128])],
      ["daily/large.md", Buffer.alloc(512 * 1024 + 13, 97)],
    ]);
    for (const [name, bytes] of files) { await writeFile(resolve(input.sourceRoot, name), bytes); inventory[name] = sha256(bytes); }
    const next = await commit(input.sourceRoot, "batch edge cases");
    assert.deepEqual(await assertGitSourceInventory({ ...input, commit: next, inventory }), Object.fromEntries(Object.entries(inventory).sort()));
    for (const [name, bytes] of files) assert.deepEqual(await readVerifiedGitSource({ ...input, commit: next, path: name, expectedHash: sha256(bytes) }), bytes);
  });
});

test("Git replacement objects cannot redefine the pinned historical source", async () => {
  await withArchive(async (input) => {
    const originalOid = (await git(input.sourceRoot, ["rev-parse", `${input.commit}:${path}`])).stdout.trim();
    await writeFile(resolve(input.sourceRoot, "replacement.txt"), "replacement object\n");
    const replacementOid = (await git(input.sourceRoot, ["hash-object", "-w", "replacement.txt"])).stdout.trim();
    await git(input.sourceRoot, ["replace", originalOid, replacementOid]);
    assert.deepEqual(await readVerifiedGitSource(input), original);
    assert.deepEqual(await assertGitSourceInventory(input), input.inventory);
  });
});

test("historical inventory verification is independent of current physical bytes only when explicit", async () => {
  await withArchive(async (input) => {
    await rm(resolve(input.sourceRoot, path));
    await commit(input.sourceRoot, "current deletion");
    await assert.rejects(assertGitSourceInventory(input), /worktree source inventory/u);
    assert.deepEqual(await assertGitSourceInventory({ ...input, verifyWorkingTree: false }), input.inventory);
    await assert.rejects(assertGitSourceInventory({ ...input, inventory: {}, verifyWorkingTree: false }), /Git source paths/u);
    await assert.rejects(assertGitSourceInventory({ ...input, verifyWorkingTree: "false" }), /must be boolean/u);
  });
});

test("batched historical reader verifies every exact requested blob independently of the worktree", async () => {
  await withArchive(async (input) => {
    const other = "daily/空白.md";
    await writeFile(resolve(input.sourceRoot, other), "");
    const snapshot = await commit(input.sourceRoot, "extra empty file");
    const inventory = { ...input.inventory, [other]: sha256("") };
    await rm(resolve(input.sourceRoot, path));
    const blobs = await readVerifiedGitSources({ ...input, commit: snapshot, inventory });
    assert.deepEqual([...blobs.keys()], Object.keys(inventory).sort());
    assert.deepEqual(blobs.get(path), original);
    assert.deepEqual(blobs.get(other), Buffer.alloc(0));
    assert.deepEqual(await readVerifiedGitSources({ ...input, inventory: {} }), new Map());
    await assert.rejects(readVerifiedGitSources({ ...input, commit: snapshot, inventory: { [path]: sha256("wrong") } }), /SHA-256/u);
    await assert.rejects(readVerifiedGitSources({ ...input, commit: snapshot, inventory: { "daily/missing.md": sha256("") } }), /missing exact/u);
    await assert.rejects(readVerifiedGitSources({ ...input, inventory: { "../escape.md": sha256("") } }), /logical POSIX/u);
  });
});

test("submodules cannot masquerade as regular historical source blobs", async () => {
  await withArchive(async (input) => {
    await git(input.sourceRoot, ["update-index", "--add", "--cacheinfo", `160000,${input.commit},daily/module.md`]);
    await git(input.sourceRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "submodule source"]);
    const next = (await git(input.sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();
    await assert.rejects(assertGitSourceInventory({ ...input, commit: next }), /submodule/u);
    await assert.rejects(readVerifiedGitSource({ ...input, commit: next, path: "daily/module.md" }), /regular Git blob/u);
    await assert.rejects(readVerifiedGitSources({ ...input, commit: next, inventory: { "daily/module.md": sha256("") } }), /regular Git blob/u);
  });
});

test("source HEAD selection binds the requested root and exact committer timestamp", async () => {
  await withArchive(async (input) => {
    const expected = (await git(input.sourceRoot, ["show", "-s", "--format=%cI", input.commit])).stdout.trim();
    assert.deepEqual(await readGitSourceHead(input), { commit: input.commit, committedAt: expected });
    await assert.rejects(readGitSourceHead({ sourceRoot: resolve(input.sourceRoot, "daily") }), /exact Git worktree root/u);
    await symlink(input.sourceRoot, resolve(input.sourceRoot, "alias"));
    await assert.rejects(readGitSourceHead({ sourceRoot: resolve(input.sourceRoot, "alias") }), /symlink/u);
  });
});

test("ambient Git repository and worktree overrides cannot redirect source HEAD selection", async () => {
  await withArchive(async (input) => {
    await withArchive(async (other) => {
      await writeFile(resolve(other.sourceRoot, path), "another repository\n");
      const otherCommit = await commit(other.sourceRoot, "unrelated source archive");
      assert.notEqual(otherCommit, input.commit);
      const expected = await readGitSourceHead(input);
      const overrides = {
        GIT_DIR: resolve(other.sourceRoot, ".git"),
        GIT_WORK_TREE: other.sourceRoot,
        GIT_INDEX_FILE: resolve(other.sourceRoot, ".git/index"),
        GIT_OBJECT_DIRECTORY: resolve(other.sourceRoot, ".git/objects"),
      };
      const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
      try {
        for (const variant of [{ GIT_DIR: overrides.GIT_DIR }, { GIT_WORK_TREE: overrides.GIT_WORK_TREE }, overrides]) {
          for (const key of Object.keys(overrides)) delete process.env[key];
          Object.assign(process.env, variant);
          assert.deepEqual(await readGitSourceHead(input), expected);
        }
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});

test("replacement commits cannot change the selected source HEAD timestamp", async () => {
  await withArchive(async (input) => {
    const expected = await readGitSourceHead(input);
    const tree = (await git(input.sourceRoot, ["rev-parse", `${input.commit}^{tree}`])).stdout.trim();
    const replacementTime = "2001-02-03T04:05:06+07:00";
    const replacement = (await execFile("git", ["-C", input.sourceRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-m", "replacement commit"], { env: { ...process.env, GIT_AUTHOR_DATE: replacementTime, GIT_COMMITTER_DATE: replacementTime } })).stdout.trim();
    await git(input.sourceRoot, ["replace", input.commit, replacement]);
    assert.equal((await git(input.sourceRoot, ["show", "-s", "--format=%cI", "HEAD"])).stdout.trim(), replacementTime);
    assert.deepEqual(await readGitSourceHead(input), expected);
    assert.notEqual(expected.committedAt, replacementTime);
  });
});
