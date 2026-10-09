// Runs only inside the credential-free container; all proposal code stays here.
import { readFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createOfflineCheckpointStore } from "./lib/offline-checkpoint-store.mjs";
const must = (v) => { if (!v) throw new Error("Audit production reconstruction rejected"); };
must(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && !process.env.ACTIONS_RUNTIME_TOKEN);
const root = resolve(process.argv[2]);
const plan = JSON.parse(await readFile("/approved/plan.json"));
must(process.versions.node === "22.23.2" && execFileSync("npm",["--version"],{encoding:"utf8"}).trim() === "10.9.9"
  && new Intl.DateTimeFormat().resolvedOptions().locale === "en-US" && new Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC");
const git = (...args) => execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
must(git("rev-parse","HEAD") === plan.proposalCommit && git("rev-parse","refs/remotes/origin/main") === plan.expectedMain);
must(execFileSync("git",["-C",`${root}/sources/bedtimenews-archive-contents`,"rev-parse","HEAD"],{encoding:"utf8"}).trim() === plan.sourceCommit);
const load = (file) => import(pathToFileURL(`${root}/scripts/lib/${file}`));
const { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint } = await load("accepted-git.mjs");
const { buildAcceptedCandidate, verifyAcceptedCandidate } = await load("accepted-candidate.mjs");
const checkpoint = await loadAcceptedGitCheckpoint({root,repository:plan.repository,commit:plan.expectedMain});
const verified = await readVerifiedAcceptedCheckpoint(checkpoint);
const store = createOfflineCheckpointStore({directory:"/approved/checkpoint",receipt:verified.manifest.auditReceipt});
const options = {checkpoint,store,generatedAt:plan.generatedAt,source:`${root}/sources/bedtimenews-archive-contents`,migrationReview:"/approved/migration-review.json",proposalCommit:plan.proposalCommit};
const candidate = await buildAcceptedCandidate(root,options);
must(candidate.manifest.bundleId === plan.bundleId);
await verifyAcceptedCandidate(root,candidate.output,options);
must(JSON.stringify((await readdir(candidate.output)).sort()) === JSON.stringify(Object.keys(plan.files).sort()));
await mkdir("/build/bundle");
for (const [name,binding] of Object.entries(plan.files)) {
  const bytes = await readFile(`${candidate.output}/${name}`);
  must(bytes.length === binding.bytes && createHash("sha256").update(bytes).digest("hex") === binding.sha256);
  await copyFile(`${candidate.output}/${name}`,`/build/bundle/${name}`);
}
console.log("Seven approved data files independently reconstructed without credentials");
