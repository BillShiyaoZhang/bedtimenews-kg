// Runs only in the credential-free build container, never in the writer job.
import { readFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const must = (v) => { if (!v) throw new Error("Candidate reconstruction rejected"); };
must(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && !process.env.ACTIONS_RUNTIME_TOKEN);
const root = resolve(process.argv[2]); const operator = resolve(process.argv[3]);
const scope = JSON.parse(await readFile(`${operator}/audit-recovery/stage-h/scope.json`));
must(process.versions.node === "22.23.2" && new Intl.DateTimeFormat().resolvedOptions().locale === "en-US" && new Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC");
must(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() === scope.proposalCommit);
const load = (file) => import(pathToFileURL(`${root}/scripts/lib/${file}`));
const { loadAcceptedGitCheckpoint } = await load("accepted-git.mjs");
const { createGitHubReleaseStore } = await load("release-store.mjs");
const { buildAcceptedCandidate, verifyAcceptedCandidate } = await load("accepted-candidate.mjs");
const checkpoint = await loadAcceptedGitCheckpoint({ root, repository: scope.repository, commit: scope.expectedMain });
const [owner, repo] = scope.repository.split("/");
const reads = new Map();
const store = createGitHubReleaseStore({ owner, repo, fetchImpl: async (url, options = {}) => {
  must(["GET", "HEAD"].includes(options.method ?? "GET"));
  // Published predecessor data is frozen by the accepted checkpoint. Reusing
  // identical public reads avoids exhausting anonymous API limits on replay.
  const key = JSON.stringify([url, options.method ?? "GET", options.headers]);
  if (reads.has(key)) { const saved = reads.get(key); return new Response(saved.bytes, { status: 200, headers: saved.headers }); }
  const response = await fetch(url, options);
  // Never tee redirects or binary bodies: cancellation of a tee waits for its
  // other branch. Fully consume bounded JSON before retaining reusable bytes.
  if (new URL(url).hostname !== "api.github.com" || options.headers?.Accept !== "application/vnd.github+json" || response.status !== 200) return response;
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; must(size <= 2 * 1024 * 1024); chunks.push(Buffer.from(chunk)); }
  const saved = { bytes: Buffer.concat(chunks), headers: response.headers };
  reads.set(key, saved); return new Response(saved.bytes, { status: 200, headers: saved.headers });
} });
const options = { checkpoint, store, generatedAt: scope.generatedAt, source: `${root}/sources/bedtimenews-archive-contents`, migrationReview: `${operator}/audit-recovery/stage-h/migration-review.json`, proposalCommit: scope.proposalCommit };
const candidate = await buildAcceptedCandidate(root, options);
must(candidate.manifest.bundleId === scope.bundleId);
await verifyAcceptedCandidate(root, candidate.output, options);
must(JSON.stringify((await readdir(candidate.output)).sort()) === JSON.stringify(Object.keys(scope.files).sort()));
await mkdir("/build/bundle", { recursive: true });
for (const [name, binding] of Object.entries(scope.files)) {
  const bytes = await readFile(`${candidate.output}/${name}`);
  must(bytes.length === binding.bytes && createHash("sha256").update(bytes).digest("hex") === binding.sha256);
  await copyFile(`${candidate.output}/${name}`, `/build/bundle/${name}`);
}
console.log("Reconstructed all seven frozen audit assets without credentials");
