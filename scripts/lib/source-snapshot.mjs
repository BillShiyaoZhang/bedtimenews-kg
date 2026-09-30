import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { isSourceReviewTimestamp, validateCandidateSourceInventory, validateCandidateSourcePath } from "./candidate-source-review.mjs";

const execFile = promisify(execFileCallback);
const COMMIT = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ensure = (value, message) => { if (!value) throw new Error(`Source snapshot: ${message}`); };
const text = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const gitArgs = (root, args) => ["--no-replace-objects", "--literal-pathspecs", "-c", "protocol.allow=never", "-C", root, ...args];
// Never fetch promised objects, invoke a credential helper, honor replacement
// objects, or inherit ambient GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_COUNT overrides.
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
async function git(root, args) {
  try {
    return (await execFile("git", gitArgs(root, args), { env: gitEnv(), encoding: "buffer", maxBuffer: 512 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new Error(`Source snapshot: local Git object unavailable or invalid (${args[0]})`, { cause: error });
  }
}

function logicalPath(path) {
  ensure(typeof path === "string" && path.length > 0 && !/[\\:\x00-\x1f\x7f]/u.test(path) && path.split("/").every((part) => part && part !== "." && part !== ".."), "path must be a safe relative logical POSIX path");
}

async function worktreeRoot(sourceRoot) {
  ensure(typeof sourceRoot === "string" && sourceRoot.trim(), "sourceRoot must be a directory");
  const root = resolve(sourceRoot);
  ensure(await realpath(root) === root && (await lstat(root)).isDirectory(), "source root or ancestor is a symlink or not a directory");
  const top = text(await git(root, ["rev-parse", "--show-toplevel"])).trim();
  ensure(top === root, "sourceRoot must be the exact Git worktree root");
  return root;
}

async function gitRoot(sourceRoot, commit) {
  ensure(typeof commit === "string" && COMMIT.test(commit), "commit must be an exact lowercase 40-hex Git commit");
  const root = await worktreeRoot(sourceRoot);
  ensure(text(await git(root, ["cat-file", "-t", commit])).trim() === "commit", "pinned object is not a Git commit");
  return root;
}

/** Pin this source worktree's own HEAD and its original committer timestamp. */
export async function readGitSourceHead({ sourceRoot }) {
  const root = await worktreeRoot(sourceRoot);
  const commit = text(await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  await gitRoot(root, commit);
  // Resolve the timestamp by the selected immutable object, not a second HEAD
  // lookup that could race a branch switch or honor a replacement commit.
  const committedAt = text(await git(root, ["show", "-s", "--format=%cI", commit])).trim();
  ensure(isSourceReviewTimestamp(committedAt), "selected HEAD has an invalid committer timestamp");
  return { commit, committedAt };
}

function treeRecords(bytes) {
  const records = [];
  const value = text(bytes);
  ensure(value === "" || value.endsWith("\0"), "incomplete Git tree output");
  for (const line of value.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/u.exec(line);
    ensure(match, "invalid Git tree entry");
    const [, mode, type, oid, path] = match;
    logicalPath(path);
    records.push({ mode, type, oid, path });
  }
  return records;
}

/** Resolve original bytes only from the exact commit, never from the worktree. */
export async function readVerifiedGitSource({ sourceRoot, commit, path, expectedHash }) {
  logicalPath(path);
  ensure(typeof expectedHash === "string" && HASH.test(expectedHash), "expectedHash must be a SHA-256");
  const root = await gitRoot(sourceRoot, commit);
  const records = treeRecords(await git(root, ["ls-tree", "-z", "--full-tree", commit, "--", path]));
  ensure(records.length === 1 && records[0].path === path, `missing exact source blob: ${path}`);
  const entry = records[0];
  ensure(entry.type === "blob" && ["100644", "100755"].includes(entry.mode), `source is not a regular Git blob: ${path}`);
  const bytes = await git(root, ["cat-file", "blob", entry.oid]);
  ensure(sha256(bytes) === expectedHash, `historical source SHA-256 mismatch: ${path}`);
  return bytes;
}

async function physicalInventory(root, includedRoots) {
  const entries = [];
  async function walk(path, relativePath, isRoot = false) {
    const stat = await lstat(path);
    ensure(!stat.isSymbolicLink(), `worktree symlink is unsupported: ${relativePath}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).filter((name) => !name.startsWith(".")).sort()) await walk(resolve(path, name), `${relativePath}/${name}`);
    } else {
      ensure(!isRoot && stat.isFile(), `worktree entry is not a regular source file: ${relativePath}`);
      if (!relativePath.endsWith(".md")) return;
      validateCandidateSourcePath(relativePath, includedRoots);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        ensure(opened.isFile() && opened.ino === stat.ino && opened.dev === stat.dev, `worktree source changed while opening: ${relativePath}`);
        entries.push([relativePath, sha256(await handle.readFile())]);
      } finally { await handle.close(); }
    }
  }
  for (const includedRoot of includedRoots) {
    const path = resolve(root, includedRoot);
    try { await lstat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await walk(path, includedRoot, true);
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

// Hash a batch as a stream instead of spawning a process per file or retaining
// the complete archive in memory. Git's batch framing is parsed as bytes.
async function verifyBlobBatch(root, entries, inventory, collect = false) {
  const blobs = collect ? new Map() : null;
  if (!entries.length) return blobs;
  const child = spawn("git", gitArgs(root, ["cat-file", "--batch"]), { env: gitEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
  const completed = new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveExit() : reject(new Error(`Source snapshot: local Git batch failed (${code}; ${stderrBytes} diagnostic bytes)`)));
  });
  // Install a rejection handler immediately while stdout is still being parsed.
  completed.catch(() => {});
  child.stdin.on("error", () => {});
  child.stdin.end(entries.map((entry) => entry.oid).join("\n") + "\n");
  let pending = Buffer.alloc(0); let index = 0; let remaining = null; let digest; let chunks;
  try {
    for await (const chunk of child.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        ensure(index < entries.length, "unexpected extra Git batch blob");
        if (remaining === null) {
          const end = pending.indexOf(10);
          if (end === -1) { ensure(pending.length < 256, "invalid Git batch header"); break; }
          const header = text(pending.subarray(0, end));
          const match = /^([a-f0-9]{40}) blob (0|[1-9]\d*)$/u.exec(header);
          ensure(match && match[1] === entries[index].oid && Number.isSafeInteger(Number(match[2])), `missing or invalid historical source blob: ${entries[index].path}`);
          remaining = Number(match[2]); digest = createHash("sha256"); chunks = [];
          pending = pending.subarray(end + 1);
        }
        if (remaining > 0) {
          const count = Math.min(remaining, pending.length);
          const bytes = pending.subarray(0, count);
          digest.update(bytes); if (collect) chunks.push(bytes);
          pending = pending.subarray(count); remaining -= count;
          if (remaining > 0) break;
        }
        if (!pending.length) break;
        ensure(pending[0] === 10, "invalid Git batch blob delimiter");
        ensure(digest.digest("hex") === inventory[entries[index].path], `Git source SHA-256 differs from observed inventory: ${entries[index].path}`);
        if (collect) blobs.set(entries[index].path, Buffer.concat(chunks));
        pending = pending.subarray(1); index += 1; remaining = null;
      }
    }
    await completed;
    ensure(index === entries.length && remaining === null && pending.length === 0, "incomplete Git source snapshot");
    return blobs;
  } catch (error) {
    child.kill();
    await completed.catch(() => {});
    throw error;
  }
}

/**
 * Assert three-way equality: supplied observed inventory, complete visible
 * in-scope Markdown worktree, and the exact committed tree. Unpublished content
 * is included. Hidden dot entries and non-Markdown files are outside this scope,
 * matching sourceInventory; symlinks/submodules in visible scope are forbidden.
 * Only checks source bytes; uncommitted out-of-scope files have no bearing here.
 * Historical replay must explicitly use verifyWorkingTree:false: committed
 * inventory completeness and byte hashes are still checked in that mode.
 */
export async function assertGitSourceInventory({ sourceRoot, commit, inventory, includedRoots, verifyWorkingTree = true }) {
  ensure(typeof verifyWorkingTree === "boolean", "verifyWorkingTree must be boolean");
  ensure(Array.isArray(includedRoots) && includedRoots.length > 0 && includedRoots.every((root) => typeof root === "string" && /^[a-z][a-z0-9_-]*$/u.test(root)) && new Set(includedRoots).size === includedRoots.length, "invalid includedRoots");
  const observed = validateCandidateSourceInventory(inventory, includedRoots);
  const root = await gitRoot(sourceRoot, commit);
  const records = treeRecords(await git(root, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...includedRoots]));
  const entries = [];
  for (const entry of records) {
    if (entry.path.split("/").some((part) => part.startsWith("."))) continue;
    ensure(entry.type === "blob" && ["100644", "100755"].includes(entry.mode), `source tree contains a symlink, submodule or nonregular entry: ${entry.path}`);
    if (!entry.path.endsWith(".md")) continue;
    validateCandidateSourcePath(entry.path, includedRoots);
    entries.push(entry);
  }
  ensure(canonicalJson(entries.map((entry) => entry.path).sort()) === canonicalJson(Object.keys(observed).sort()), "complete Git source paths differ from observed inventory");
  await verifyBlobBatch(root, entries, observed);
  if (verifyWorkingTree) ensure(canonicalJson(await physicalInventory(root, includedRoots)) === canonicalJson(observed), "complete worktree source inventory differs from observed inventory");
  return observed;
}

/** Read a verified subset in one Git batch; assertGitSourceInventory checks scope completeness. */
export async function readVerifiedGitSources({ sourceRoot, commit, inventory }) {
  ensure(inventory !== null && typeof inventory === "object" && !Array.isArray(inventory), "inventory must be a path-to-SHA-256 object");
  canonicalJson(inventory);
  for (const [path, expectedHash] of Object.entries(inventory)) {
    logicalPath(path);
    ensure(typeof expectedHash === "string" && HASH.test(expectedHash), `invalid expected source SHA-256: ${path}`);
  }
  const root = await gitRoot(sourceRoot, commit);
  const paths = Object.keys(inventory).sort();
  if (!paths.length) return new Map();
  const roots = [...new Set(paths.map((path) => path.split("/")[0]))].sort();
  const records = treeRecords(await git(root, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...roots]));
  const selected = new Map();
  for (const entry of records) {
    if (!Object.hasOwn(inventory, entry.path)) continue;
    ensure(!selected.has(entry.path), `ambiguous source tree path: ${entry.path}`);
    ensure(entry.type === "blob" && ["100644", "100755"].includes(entry.mode), `source is not a regular Git blob: ${entry.path}`);
    selected.set(entry.path, entry);
  }
  ensure(paths.every((path) => selected.has(path)), "missing exact historical source blob");
  return verifyBlobBatch(root, paths.map((path) => selected.get(path)), inventory, true);
}
