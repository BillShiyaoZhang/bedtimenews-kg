import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { loadAcceptedGitCheckpoint } from "../scripts/lib/accepted-git.mjs";
import { buildAcceptedCandidate, previewAcceptedMigration } from "../scripts/lib/accepted-candidate.mjs";
import { createAcceptedRelease } from "../scripts/lib/accepted-release.mjs";
import { validateMigrationPullRequest } from "../scripts/lib/migration-pr-validation.mjs";

const project = fileURLToPath(new URL("..", import.meta.url));
const repository = "fixture/migration-pr";
const generatedAt = "2026-01-03T00:00:00Z";
const bytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const execFile = promisify(execFileCallback);
const run = (cwd, command, args) => execFile(command, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
const git = (cwd, args) => run(cwd, "git", args);
const head = async (cwd) => (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
async function commit(root, paths = ["."]) {
  await git(root, ["add", "--", ...paths]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  return head(root);
}
function receiptFor(manifest, targetCommit, releaseId) {
  const tag = `kg-audit-${manifest.bundleId}`;
  const bindings = { ...manifest.artifacts, "manifest.json": { sha256: sha256(bytes(manifest)), bytes: bytes(manifest).length } };
  return { schemaVersion: 2, kind: "github-audit-readback", repository, bundleId: manifest.bundleId, manifestSha256: bindings["manifest.json"].sha256,
    targetCommit, tag, releaseId, releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
    githubImmutableAtReadback: false, visibilityAtReadback: "draft", readbackVerified: true,
    assets: Object.fromEntries(Object.entries(bindings).map(([name, binding], index) => {
      const assetName = `${binding.sha256}-${name}`;
      return [name, { ...binding, id: releaseId * 100 + index, name: assetName, url: `https://github.com/${repository}/releases/download/${tag}/${assetName}` }];
    })), rawSourceArchiveIncluded: false,
    sourceReplay: "Restoring accepted outputs does not guarantee raw upstream re-extraction; upstream Git history must be available separately." };
}
async function workspace(callback) {
  const root = await mkdtemp(resolve(tmpdir(), "migration-pr-fixture-"));
  try {
    await cp(resolve(project, "scripts"), resolve(root, "scripts"), { recursive: true });
    await cp(resolve(project, "app/lib"), resolve(root, "app/lib"), { recursive: true });
    await mkdir(resolve(root, "data/generated"), { recursive: true }); await mkdir(resolve(root, "data/processed"));
    for (const name of ["ontology-source.json", "ontology.json", "extraction-patterns.json", "extraction-rules.json", "news-overrides.json"]) await cp(resolve(project, "data", name), resolve(root, "data", name));
    const archive = resolve(root, "sources/bedtimenews-archive-contents");
    await mkdir(resolve(archive, "daily"), { recursive: true });
    await writeFile(resolve(archive, "daily/one.md"), "---\ntitle: 劳动新闻\npublished: true\ndateCreated: 2026-01-01T00:00:00Z\n---\n北京市介绍工资与劳动情况。\n");
    await git(archive, ["init", "-q"]); await commit(archive);
    await run(root, process.execPath, ["scripts/update-kg.mjs", "--bootstrap", "--source", archive, "--include", "daily"]);
    await writeFile(resolve(root, ".gitignore"), "work/\n*.review.json\n");
    await git(root, ["init", "-q"]); await git(root, ["remote", "add", "origin", `https://github.com/${repository}.git`]);
    const origin = await commit(root); await git(root, ["update-ref", "refs/remotes/origin/main", origin]);
    const audits = new Map(); let reads = 0;
    const store = { async readBundle({ receipt }) {
      reads++; const saved = audits.get(receipt.bundleId); assert.ok(saved, "fixture audit exists");
      assert.deepEqual(receipt, saved.receipt);
      return { manifest: structuredClone(saved.manifest), files: new Map([...saved.files].map(([name, value]) => [name, Buffer.from(value)])) };
    } };
    async function payload(result, codeCommit) {
      const auditReceipt = receiptFor(result.manifest, codeCommit, audits.size + 1);
      const files = new Map(await Promise.all([...Object.keys(result.manifest.artifacts), "manifest.json"].map(async (name) => [name, await readFile(resolve(result.output, name))])));
      audits.set(result.manifest.bundleId, { manifest: result.manifest, files, receipt: auditReceipt });
      const release = createAcceptedRelease({ candidateManifest: result.manifest, lifecycle: result.artifacts["lifecycle.json.gz"], acceptedFiles: result.acceptedFiles,
        origin: result.origin, predecessor: result.checkpoint ? { commit: result.checkpoint.commit, releaseId: result.checkpoint.manifest.releaseId, bundleId: result.checkpoint.manifest.candidateBundleId } : null,
        codeCommit, sourceCommit: result.manifest.inputs.recipe.archiveCommit, auditReceipt, mode: result.mode, transition: result.transition,
        verifiedPredecessor: result.checkpoint, auditRepository: repository });
      for (const [path, content] of result.acceptedFiles) await writeFile(resolve(root, path), content);
      await writeFile(resolve(root, "data/accepted-release.json"), bytes(release));
      return release;
    }
    const seed = await buildAcceptedCandidate(root, { source: archive, checkpoint: await loadAcceptedGitCheckpoint({ root, repository, commit: origin }), store, generatedAt, output: "work/accepted/seed" });
    await payload(seed, origin); const baseCommit = await commit(root, ["data"]);
    await git(root, ["update-ref", "refs/remotes/origin/main", baseCommit]);
    const acquireSource = async ({ directory, commit: expected }) => {
      await cp(archive, directory, { recursive: true });
      await git(directory, ["checkout", "--detach", expected]);
      return directory;
    };
    const options = { root, repository, baseCommit, store, acquireSource };
    async function proposal() {
      const path = resolve(root, "data/extraction-patterns.json"); const patterns = JSON.parse(await readFile(path, "utf8"));
      patterns.version = "4.1.1"; patterns.topics.find((topic) => topic.conceptId === "topic-labor").extractionTriggers = ["新的劳动主题线索"];
      await writeFile(path, `${JSON.stringify(patterns, null, 2)}\n`); await run(root, process.execPath, ["scripts/compile-ontology.mjs"]);
      const proposalCommit = await commit(root, ["data"]);
      const checkpoint = await loadAcceptedGitCheckpoint({ root, repository, commit: baseCommit });
      const candidateOptions = { source: archive, checkpoint, store, proposalCommit, generatedAt };
      const preview = await previewAcceptedMigration(root, candidateOptions);
      const migrationReview = resolve(root, "migration.review.json");
      await writeFile(migrationReview, bytes({ ...preview.reviewBinding, reviewedAt: generatedAt, reason: "Review rule change and full derived projection" }));
      const result = await buildAcceptedCandidate(root, { ...candidateOptions, migrationReview, output: "work/accepted/migration" });
      const manifest = await payload(result, proposalCommit); await commit(root, ["data"]);
      return { result, manifest, proposalCommit };
    }
    await callback({ ...options, options, origin, proposal, getReads: () => reads });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("unchanged accepted receipt validates rendering without reading draft audits or raw source", async () => {
  await workspace(async ({ options, getReads }) => {
    const before = getReads();
    const result = await validateMigrationPullRequest({ ...options, headRepository: "fork/repository", acquireSource: async () => { throw new Error("source must not be acquired"); } });
    assert.equal(result.kind, "unchanged-receipt"); assert.equal(result.freshSourceReplay, false); assert.equal(getReads(), before);
  });
});

test("coherent migration PR independently replays exact audit and raw sources against accepted base", async () => {
  await workspace(async ({ options, proposal, root, origin, store }) => {
    const proposed = await proposal();
    const result = await validateMigrationPullRequest(options);
    assert.equal(result.kind, "independently-verified-migration"); assert.equal(result.freshSourceReplay, true);
    assert.equal(result.accepted, false); assert.equal(result.proposalCommit, proposed.proposalCommit);
    assert.equal(result.releaseId, proposed.manifest.releaseId);
    await assert.rejects(validateMigrationPullRequest({ ...options, baseCommit: origin }), /exact pinned accepted main/u);
    await assert.rejects(validateMigrationPullRequest({ ...options, headRepository: "fork/repository" }), /same-repository maintainer branch/u);
    await assert.rejects(validateMigrationPullRequest({ ...options, acquireSource: async () => { throw new Error("pinned source unavailable"); } }), /pinned source unavailable/u);
    await assert.rejects(validateMigrationPullRequest({ ...options, acquireSource: async (request) => {
      const directory = await options.acquireSource(request);
      const file = resolve(directory, "daily/one.md");
      await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("Unexpected local source edit.\n")]));
      return directory;
    } }), /source change requires exact review|Git source SHA-256 differs|worktree source inventory differs/u);
    const changedAudit = { async readBundle(input) {
      const value = await store.readBundle(input);
      if (input.receipt.bundleId === proposed.result.manifest.bundleId) value.files.set("diff.json", Buffer.from("{}\n"));
      return value;
    } };
    await assert.rejects(validateMigrationPullRequest({ ...options, store: changedAudit }), /audit artifact bytes differ/u);
    const newsPath = resolve(root, "data/processed/news.json");
    await writeFile(newsPath, Buffer.concat([await readFile(newsPath), Buffer.from("\n")])); await commit(root, ["data/processed/news.json"]);
    await assert.rejects(validateMigrationPullRequest(options), /output bytes differ/u);
  });
});

test("code changes after proposed ancestor are refused rather than verified under different code", async () => {
  await workspace(async ({ options, proposal, root }) => {
    await proposal(); await writeFile(resolve(root, "README.md"), "Later unbound proposal change\n"); await commit(root, ["README.md"]);
    await assert.rejects(validateMigrationPullRequest(options), /changed after the reviewed proposal commit/u);
  });
});
