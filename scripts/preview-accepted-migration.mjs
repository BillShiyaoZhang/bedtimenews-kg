#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./lib/candidate-bundle.mjs";
import { loadAcceptedGitCheckpoint } from "./lib/accepted-git.mjs";
import { createGitHubReleaseStore } from "./lib/release-store.mjs";
import { createReleaseGitTransport } from "./lib/release-runtime.mjs";
import { RELEASE_NODE_VERSION } from "./lib/release-sync.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2); const prefixes = ["--source=", "--source-review=", "--output="];
if (args.some((arg) => !prefixes.some((prefix) => arg.startsWith(prefix)))) throw new Error("Usage: kg:release:migration:preview [--source=path] [--source-review=path] [--output=work/file.json]");
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const runtime = new Intl.DateTimeFormat().resolvedOptions();
if (process.versions.node !== RELEASE_NODE_VERSION || runtime.timeZone !== "UTC" || runtime.locale !== "en-US") throw new Error(`Preview requires Node ${RELEASE_NODE_VERSION}, en-US locale and UTC`);
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) throw new Error("An explicit GITHUB_REPOSITORY is required");
const [owner, repo] = repository.split("/");
const store = createGitHubReleaseStore({ owner, repo, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  fetchImpl: (url, options = {}) => {
    if (!["GET", "HEAD"].includes(options.method ?? "GET")) throw new Error("Migration preview cannot mutate remote storage");
    return globalThis.fetch(url, options);
  } });
const commit = await createReleaseGitTransport(root, { repository }).fetchMain();
const checkpoint = await loadAcceptedGitCheckpoint({ root, repository, commit });
const { previewAcceptedMigration } = await import("./lib/accepted-candidate.mjs");
const preview = await previewAcceptedMigration(root, { checkpoint, store, ...(option("source") ? { source: option("source") } : {}), ...(option("source-review") ? { sourceReview: option("source-review") } : {}) });
const output = resolve(root, option("output") ?? "work/migration-preview.json");
if (!output.startsWith(`${resolve(root, "work")}${sep}`) || !output.endsWith(".json")) throw new Error("Preview output must be a JSON file inside ignored work/");
await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${canonicalJson(preview)}\n`);
console.log(`Read-only migration preview saved to ${output}; no audit upload, acceptance or publication was performed`);
