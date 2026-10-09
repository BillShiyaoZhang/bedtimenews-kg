#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGitHubReleaseStore } from "./lib/release-store.mjs";
import { createOfflineCheckpointStore } from "./lib/offline-checkpoint-store.mjs";
import { createSnapshotSplitStore } from "./lib/audit-snapshot.mjs";
import { validateMigrationPullRequest } from "./lib/migration-pr-validation.mjs";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => !arg.startsWith("--base="))) throw new Error("Usage: validate-migration-pr.mjs --base=<exact accepted main SHA>");
const baseCommit = args[0]?.slice("--base=".length) ?? process.env.KG_RELEASE_BASE_COMMIT;
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || !/^[a-f0-9]{40}$/u.test(baseCommit ?? "")) throw new Error("PR validation requires exact repository and fetched accepted base SHA");
// Missing/unknown PR identity must not expose collaborator-only draft assets.
const sameRepository = process.env.KG_RELEASE_PR_SAME_REPOSITORY === "true";
let client;
const publishedStore = { async readBundle(options) {
  if (!sameRepository) throw new Error("Semantic migration draft audit needs a same-repository maintainer branch");
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Semantic migration audit is unavailable: contents:read access is required");
  if (!client) {
    const [owner, repo] = repository.split("/");
    client = createGitHubReleaseStore({ owner, repo, token, fetchImpl: (url, request = {}) => {
      if (!["GET", "HEAD"].includes(request.method ?? "GET")) throw new Error("PR validation cannot mutate audit storage");
      return globalThis.fetch(url, request);
    } });
  }
  return client.readBundle(options);
} };
let store = publishedStore;
if (process.env.KG_RELEASE_AUDIT_SNAPSHOT) {
  const candidate = JSON.parse(await readFile(new URL("../data/accepted-release.json", import.meta.url)));
  const base = JSON.parse((await execFile("git", ["--no-replace-objects", "-C", root, "show", `${baseCommit}:data/accepted-release.json`], { maxBuffer: 1024 * 1024 })).stdout);
  store = createSnapshotSplitStore({ candidateReceipt: candidate.auditReceipt, predecessorReceipt: base.auditReceipt,
    candidateStore: createOfflineCheckpointStore({ directory: process.env.KG_RELEASE_AUDIT_SNAPSHOT, receipt: candidate.auditReceipt }), publishedStore });
}
async function acquireSource({ directory, repository: source, commit }) {
  if (source.name !== "bedtimenews/bedtimenews-archive-contents" || source.url !== "https://github.com/bedtimenews/bedtimenews-archive-contents" || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error("PR source replay accepts only the fixed reviewed upstream and exact commit");
  }
  await mkdir(directory);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const args of [["init", "--quiet"], ["remote", "add", "origin", `${source.url}.git`], ["fetch", "--no-tags", "--no-recurse-submodules", "origin", commit], ["checkout", "--detach", commit]]) {
    try {
      await execFile("git", ["--no-replace-objects", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-C", directory, ...args],
        { env, maxBuffer: 1024 * 1024 });
    } catch { throw new Error(`Pinned upstream source ${args[0]} failed; original raw history is required for migration PR validation`); }
  }
  return directory;
}
const result = await validateMigrationPullRequest({ root, repository, baseCommit, headRepository: sameRepository ? repository : "fork", store, acquireSource });
console.log(JSON.stringify(result));
console.log(result.freshSourceReplay ? "Proposed migration independently replayed. It remains unaccepted until ordinary reviewed merge." : "Unchanged receipt and rendered projection validated. No fresh raw-source replay was performed by this gate.");
