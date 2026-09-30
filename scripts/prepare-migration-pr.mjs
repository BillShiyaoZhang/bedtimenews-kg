#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseApproval, RELEASE_NODE_VERSION, createFileReleaseJournal, releaseStoreJournalOptions, prepareMigrationPullRequest } from "./lib/release-sync.mjs";
import { createReleaseGitTransport, validatePreparedRelease } from "./lib/release-runtime.mjs";
import { createGitHubReleaseStore } from "./lib/release-store.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repository = process.env.GITHUB_REPOSITORY;
const approval = { activated: process.env.KG_RELEASE_ACTIVATED === "true", storageRepository: process.env.KG_RELEASE_STORAGE_APPROVED };
assertReleaseApproval(approval, repository);
if (process.env.GITHUB_ACTIONS === "true") throw new Error("Migration PR preparation is a local operator command; PR Actions never receive release-write credentials");
const runtime = new Intl.DateTimeFormat().resolvedOptions();
if (process.versions.node !== RELEASE_NODE_VERSION || runtime.timeZone !== "UTC" || runtime.locale !== "en-US") throw new Error(`Migration PR preparation requires Node ${RELEASE_NODE_VERSION}, en-US locale and UTC`);
const args = process.argv.slice(2); const prefixes = ["--proposal=", "--proposal-ref=", "--migration-review=", "--source=", "--source-review="];
if (args.some((arg) => !prefixes.some((prefix) => arg.startsWith(prefix))) || new Set(args.map((arg) => arg.split("=", 1)[0])).size !== args.length) throw new Error("Use explicit --proposal=SHA --proposal-ref=refs/heads/branch --migration-review=path; optional --source=path and --source-review=path");
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!/^[a-f0-9]{40}$/u.test(option("proposal") ?? "") || !option("proposal-ref")?.startsWith("refs/heads/") || !option("migration-review")) throw new Error("Exact proposal SHA, explicit non-main proposal ref and reviewed migration file are required");
const [owner, repo] = repository.split("/");
const journal = await createFileReleaseJournal(resolve(root, "work/migration-pr-journal.json"), repository);
const store = createGitHubReleaseStore({ owner, repo, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, ...await releaseStoreJournalOptions(journal) });
const result = await prepareMigrationPullRequest({ root, repository, approval, journal, store, transport: createReleaseGitTransport(root, { repository }),
  proposalCommit: option("proposal"), proposalRef: option("proposal-ref"), migrationReview: option("migration-review"),
  ...(option("source") ? { source: resolve(root, option("source")) } : {}), sourceReview: option("source-review"),
  validatePrepared: (options) => validatePreparedRelease(root, options, { onProgress: console.log }), onProgress: console.log });
console.log(JSON.stringify(result));
console.log("Prepared a local code+data commit only. No main or proposal branch was moved, push/PR was created, public audit was published, or Pages run was dispatched. Ordinary reviewed PR merge remains required.");
