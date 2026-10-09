// Trusted main operator only. No package installation or proposal imports.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalJson, sha256 } from "./lib/candidate-bundle.mjs";
import { validateProductionPlan, snapshotProducer, validateSnapshotDirectory } from "./lib/audit-snapshot.mjs";
import { readApprovedProductionPlan } from "./lib/download-audit-snapshot.mjs";
import { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint } from "./lib/accepted-git.mjs";
import { createGitHubReleaseStore, prepareAuditBundle } from "./lib/release-store.mjs";
import { verifyLiveCombinedHead } from "./lib/audit-live-verification.mjs";
import { createAuditProductionJournal } from "./lib/audit-production-journal.mjs";
try {
const must = (v) => { if (!v) throw new Error("Trusted audit production rejected"); };
const root = resolve(import.meta.dirname, ".."), env = process.env;
const [mode, directoryArg] = process.argv.slice(2); must(["history", "produce", "verify"].includes(mode) && directoryArg);
const directory = resolve(directoryArg);
const policy = JSON.parse(await readFile(resolve(root,"audit-snapshots/policy.json")));
const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH));
must(env.GITHUB_ACTIONS === "true" && env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_RUN_ATTEMPT === "1"
  && env.GITHUB_REF === "refs/heads/main" && env.GITHUB_REPOSITORY === policy.repository
  && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA && /^[a-f0-9]{40}$/u.test(env.GITHUB_SHA)
  && env.GITHUB_ACTOR === policy.actor.login && env.GITHUB_TRIGGERING_ACTOR === policy.actor.login && env.GITHUB_ACTOR_ID === String(policy.actor.id)
  && env.GITHUB_WORKFLOW_REF === `${policy.repository}/${policy.workflowPath}@refs/heads/main`
  && /^[a-f0-9]{40}$/u.test(event.inputs?.plan_commit) && /^[a-f0-9]{64}$/u.test(event.inputs?.plan_sha256)
  && ["produce","verify"].includes(event.inputs?.operation) && (mode === "history" || mode === event.inputs.operation));
must(process.versions.node === "22.23.2" && new Intl.DateTimeFormat().resolvedOptions().locale === "en-US" && new Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC");
must(execFileSync("git",["--no-replace-objects","-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim() === env.GITHUB_SHA);
const api = async (path,{method="GET",body,missing=false}={}) => {
  must(path.startsWith("/") && !path.includes("..") && (mode === "produce" || method === "GET"));
  const response = await fetch(`https://api.github.com/repos/${policy.repository}${path}`,{method,redirect:"error",signal:AbortSignal.timeout(30_000),
    headers:{Authorization:`Bearer ${env.GH_TOKEN}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2026-03-10",...(body?{"Content-Type":"application/json"}:{})},...(body?{body:canonicalJson(body)}:{})});
  if (missing && response.status === 404) return null;
  must(response.ok); let size=0; const chunks=[];
  for await (const chunk of response.body) { size+=chunk.length; must(size<=4*1024*1024); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks));
};
const planBytes = await readApprovedProductionPlan(api,event.inputs.plan_commit);
must(sha256(planBytes) === event.inputs.plan_sha256);
const plan = validateProductionPlan(JSON.parse(planBytes),{policy,baseCommit:env.GITHUB_SHA});
must(planBytes.equals(Buffer.from(`${canonicalJson(plan)}\n`)));
const run = await api(`/actions/runs/${env.GITHUB_RUN_ID}`);
must(String(run.id) === env.GITHUB_RUN_ID && run.run_attempt === 1 && run.head_sha === env.GITHUB_SHA && run.head_branch === "main"
  && run.path === policy.workflowPath && run.event === "workflow_dispatch" && run.actor.id === policy.actor.id && run.triggering_actor.id === policy.actor.id
  && run.repository.full_name === policy.repository && run.head_repository.full_name === policy.repository);
const producer = snapshotProducer(run);
const checkFrozen = async () => {
  const main = await api("/git/ref/heads/main"), proposal = await api(`/git/ref/${plan.proposalRef.slice(5)}`);
  const expectedHead = event.inputs.operation === "verify" ? event.inputs.combined_head : plan.proposalCommit;
  must(/^[a-f0-9]{40}$/u.test(expectedHead) && main.object?.sha === plan.expectedMain && proposal.object?.sha === expectedHead);
};
await checkFrozen();
const [owner,repo] = policy.repository.split("/");
const readOnlyFetch = (url,options={}) => { must(["GET","HEAD"].includes(options.method??"GET")); return fetch(url,options); };
if (mode === "history") {
  const capability = await loadAcceptedGitCheckpoint({root,repository:policy.repository,commit:plan.expectedMain});
  const checkpoint = await readVerifiedAcceptedCheckpoint(capability);
  const store = createGitHubReleaseStore({owner,repo,token:env.GH_TOKEN,fetchImpl:readOnlyFetch});
  const downloaded = await store.readBundle({receipt:checkpoint.manifest.auditReceipt});
  await mkdir(directory);
  await mkdir(resolve(directory,"checkpoint"));
  for (const [name,bytes] of downloaded.files) await writeFile(resolve(directory,"checkpoint",name),bytes,{flag:"wx"});
  await writeFile(resolve(directory,"plan.json"),planBytes,{flag:"wx"});
  await writeFile(resolve(directory,"migration-review.json"),`${canonicalJson(plan.migrationReview)}\n`,{flag:"wx"});
} else {
  const described = await prepareAuditBundle(directory);
  must(described.bundleId === plan.bundleId);
  for (const [name,binding] of Object.entries(plan.files)) must(described.files[name].bytes === binding.bytes && described.files[name].sha256 === binding.sha256);
  let journal = {};
  if (mode === "produce") {
    must(env.KG_RELEASE_ACTIVATED === "true" && env.KG_RELEASE_STORAGE_APPROVED === policy.repository);
    journal = await createAuditProductionJournal({api,plan,planSha256:event.inputs.plan_sha256,producer,checkFrozen});
  }
  const store = createGitHubReleaseStore({owner,repo,token:env.GH_TOKEN,...journal,...(mode==="verify"?{fetchImpl:readOnlyFetch}:{})});
  const options = {bundleDir:directory,targetCommit:plan.proposalCommit};
  const receipt = await (mode === "produce" ? store.stageBundle(options) : store.verifyBundle(options));
  must(receipt.visibilityAtReadback === "draft");
  const downloaded = await store.readBundle({receipt});
  const verification = mode === "verify" ? { ...await verifyLiveCombinedHead({api,plan,combinedHead:event.inputs.combined_head,receipt}), receiptSha256: sha256(canonicalJson(receipt)) } : null;
  await checkFrozen();
  const output = resolve(directory,"../verified-snapshot"); await mkdir(output);
  for (const [name,bytes] of downloaded.files) await writeFile(resolve(output,name),bytes,{flag:"wx"});
  const snapshot = {schemaVersion:1,kind:"verified-audit-snapshot",operation:mode,verification,plan,planCommit:event.inputs.plan_commit,planSha256:event.inputs.plan_sha256,receipt,producer};
  await writeFile(resolve(output,"snapshot.json"),`${canonicalJson(snapshot)}\n`,{flag:"wx"});
  await validateSnapshotDirectory({directory:output,policy,baseCommit:plan.expectedMain,receipt,producer,approvedPlanBytes:planBytes});
  console.log(JSON.stringify({status:"live-verified",bundleId:plan.bundleId,releaseId:receipt.releaseId,receiptSha256:sha256(canonicalJson(receipt)),mode,verification}));
}

} catch {
  console.error("Trusted audit operation failed; no automatic retry or acceptance occurred. Inspect retained operation evidence before another write.");
  process.exitCode = 1;
}
