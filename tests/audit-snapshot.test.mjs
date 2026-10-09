import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { createSnapshotSplitStore, discoverSnapshotArtifacts, SNAPSHOT_FILES, snapshotProducer, validateSnapshotDirectory } from "../scripts/lib/audit-snapshot.mjs";
import { downloadAuditSnapshot } from "../scripts/lib/download-audit-snapshot.mjs";
import { createHash } from "node:crypto";
import { createSnapshotReadClient } from "../scripts/lib/audit-snapshot-http.mjs";
const execFile = promisify(callback);
const encode = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const baseCommit = "a".repeat(40), proposalCommit = "b".repeat(40);
const policy = { repository: "fixture/repo", actor: { id: 1, login: "maintainer" }, workflowPath: ".github/workflows/audit-snapshot.yml", maximumPages: 2, maximumArchiveBytes: 135266304 };
const run = { id: 3, workflow_id: 2, path: policy.workflowPath, head_sha: baseCommit, head_branch: "main", event: "workflow_dispatch", run_attempt: 1, status: "completed", conclusion: "success", actor: policy.actor, triggering_actor: policy.actor, repository: { id: 4, full_name: policy.repository }, head_repository: { id: 4, full_name: policy.repository } };
const artifact = { id: 5, name: `kg-audit-snapshot-${"c".repeat(64)}`, workflow_run: { id: 3, head_sha: baseCommit, repository_id: 4, head_repository_id: 4 }, size_in_bytes: 20, digest: `sha256:${"d".repeat(64)}`, expired: false, expires_at: "2099-01-01T00:00:00Z" };
const receiptLocator = { repository: policy.repository, bundleId: "c".repeat(64) };
function apiFor({ artifacts = [artifact], producer = run, total = artifacts.length } = {}) {
  return async (path) => path.startsWith("/actions/workflows/") ? { id: 2, path: policy.workflowPath } : path.startsWith("/actions/runs/") ? producer : { total_count: total, artifacts };
}
test("snapshot discovery pins producer identity and rejects failed, expired and incomplete runs", async () => {
  const options = { policy, baseCommit, receipt: receiptLocator };
  assert.equal((await discoverSnapshotArtifacts({ ...options, api: apiFor() }))[0].artifact.id, 5);
  for (const update of [{ head_sha: proposalCommit }, { conclusion: "failure" }, { run_attempt: 2 }, { event: "pull_request" }, { actor: { id: 2 } }, { path: "other.yml" }]) {
    await assert.rejects(discoverSnapshotArtifacts({ ...options, api: apiFor({ producer: { ...run, ...update } }) }));
  }
  await assert.rejects(discoverSnapshotArtifacts({ ...options, api: apiFor({ artifacts: [{ ...artifact, expired: true }] }) }));
  await assert.rejects(discoverSnapshotArtifacts({ ...options, api: apiFor({ total: 2 }) }));
});
test("split store recognizes only exact candidate and predecessor, without fallback on corruption", async () => {
  let published = 0;
  const candidateReceipt = { id: 1 }, predecessorReceipt = { id: 2 };
  const store = createSnapshotSplitStore({ candidateReceipt, predecessorReceipt, candidateStore: { readBundle() { throw new Error("corrupt"); } }, publishedStore: { readBundle() { published++; return "history"; } } });
  await assert.rejects(store.readBundle({ receipt: candidateReceipt }), /corrupt/u);
  await assert.rejects(store.readBundle({ receipt: { id: 3 } }), /unrecognized/u);
  assert.equal(published, 0);
  assert.equal(await store.readBundle({ receipt: predecessorReceipt }), "history");
});
async function fixture(callback) {
  const directory = await mkdtemp(resolve(tmpdir(), "snapshot-test-"));
  try {
    const migrationReview = { kind: "semantic-migration", reason: "Reviewed fixture" };
    const files = Object.fromEntries(SNAPSHOT_FILES.filter((n) => n !== "manifest.json").map((n) => [n, Buffer.from("null\n")]));
    const binding = (b) => ({ bytes: b.length, sha256: sha256(b) });
    const payload = { schemaVersion: 1, kind: "offline-candidate", artifacts: Object.fromEntries(Object.entries(files).map(([n,b]) => [n,binding(b)])), inputs: { reviewProposal: { commit: proposalCommit }, recipe: { archiveCommit: "e".repeat(40), generatedAt: "2026-01-01T00:00:00Z" }, transition: { review: migrationReview } } };
    const bundleId = sha256(canonicalJson(payload)); files["manifest.json"] = encode({ ...payload, bundleId });
    const bindings = Object.fromEntries(Object.entries(files).map(([n,b]) => [n,binding(b)]));
    const plan = { schemaVersion: 1, kind: "reviewed-audit-production-plan", repository: policy.repository, expectedMain: baseCommit, proposalCommit, proposalRef: "refs/heads/review/fixture", sourceCommit: "e".repeat(40), bundleId, storageApproved: true, actor: policy.actor, reason: "Reviewed fixture", reviewedAt: "2026-01-01T00:00:00.000Z", generatedAt: "2026-01-01T00:00:00Z", runtime: { node: "22.23.2", npm: "10.9.9", locale: "en-US", timeZone: "UTC" }, migrationReview, migrationReviewSha256: sha256(encode(migrationReview)), files: bindings };
    const receipt = { repository: policy.repository, bundleId, targetCommit: proposalCommit, readbackVerified: true, visibilityAtReadback: "draft", assets: bindings, manifestSha256: bindings["manifest.json"].sha256 };
    const snapshot = { schemaVersion: 1, kind: "verified-audit-snapshot", operation: "produce", verification: null, plan, planCommit: "f".repeat(40), planSha256: sha256(encode(plan)), receipt, producer: snapshotProducer(run) };
    for (const [n,b] of Object.entries(files)) await writeFile(resolve(directory,n),b);
    await writeFile(resolve(directory,"snapshot.json"),encode(snapshot));
    await callback({ directory, policy, baseCommit, receipt, producer: snapshotProducer(run), approvedPlanBytes: encode(plan) });
  } finally { await rm(directory,{recursive:true,force:true}); }
}
test("snapshot binds approved Git plan bytes and exact producer", async () => {
  await fixture(async (options) => {
    assert.equal((await validateSnapshotDirectory(options)).receipt.bundleId,options.receipt.bundleId);
    await assert.rejects(validateSnapshotDirectory({ ...options, approvedPlanBytes: Buffer.from("{}\n") }), /approved Git/u);
    await assert.rejects(validateSnapshotDirectory({ ...options, producer: { ...options.producer, runId: 90 } }), /producer/u);
    await writeFile(resolve(options.directory,"news.json"),"evil\n");
    await assert.rejects(validateSnapshotDirectory(options), /unsafe|differs/u);
  });
});
for (const type of ["symlink","hardlink"]) test(`snapshot rejects ${type} before reading`, async () => {
  await fixture(async (options) => {
    const path = resolve(options.directory,"news.json"); await rm(path);
    await (type === "symlink" ? symlink : link)(resolve(options.directory,"kg.json"),path);
    await assert.rejects(validateSnapshotDirectory(options), /unsafe/u);
  });
});
test("archive GET strips credentials on redirect and checks digest", async () => {
  const bytes = Buffer.from("fixture"); let calls = 0;
  const client = createSnapshotReadClient({ repository: policy.repository, token: "test-only", fetchImpl: async (url, options) => {
    calls++;
    if (calls === 1) { assert.ok(options.headers.Authorization); return new Response(null,{status:302,headers:{location:"https://fixture.blob.core.windows.net/data?signature=fake"}}); }
    assert.equal(options.headers,undefined); assert.equal(options.redirect,"error"); return new Response(bytes);
  } });
  assert.deepEqual(await client.download({ id: 1, size_in_bytes: bytes.length, digest: `sha256:${sha256(bytes)}` },100),bytes);
  const evil = createSnapshotReadClient({ repository: policy.repository, token: "test-only", fetchImpl: async () => new Response(null,{status:302,headers:{location:"https://attacker.invalid/file"}}) });
  await assert.rejects(evil.download({ id:1,size_in_bytes:bytes.length,digest:`sha256:${sha256(bytes)}` },100));
});
test("safe extraction rejects traversal, duplicate and symbolic ZIP entries", async () => {
  const directory = await mkdtemp(resolve(tmpdir(),"zip-snapshot-test-"));
  try {
    for (const variant of ["valid","traversal","duplicate","symlink"]) {
      const archive = resolve(directory,`${variant}.zip`), destination = resolve(directory,variant);
      await execFile("python3",["-c",`import zipfile,sys\nnames=${JSON.stringify([...SNAPSHOT_FILES,"snapshot.json"])}\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name in names:\n  info=zipfile.ZipInfo("../news.json" if sys.argv[2]=="traversal" and name=="news.json" else name)\n  if sys.argv[2]=="symlink" and name=="news.json": info.external_attr=0o120777<<16\n  z.writestr(info,b"null\\n")\n if sys.argv[2]=="duplicate": z.writestr("news.json",b"null\\n")`,archive,variant]);
      const extraction = execFile("python3",["-I",resolve("scripts/extract-audit-snapshot.py"),archive,destination]);
      if (variant === "valid") await extraction; else await assert.rejects(extraction);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});


test("approved producer artifact downloads through plan Git binding into a strict offline store", async () => {
  await fixture(async (options) => {
    const metadata = JSON.parse(await readFile(resolve(options.directory,"snapshot.json")));
    const archive = resolve(options.directory,"../"+options.receipt.bundleId+".zip");
    try {
      await execFile("python3",["-c","import zipfile,sys,pathlib\nwith zipfile.ZipFile(sys.argv[2], 'w') as z:\n for p in pathlib.Path(sys.argv[1]).iterdir(): z.write(p,p.name)",options.directory,archive]);
      const archiveBytes=await readFile(archive), planBytes=options.approvedPlanBytes;
      const blobSha=createHash("sha1").update(`blob ${planBytes.length}\0`).update(planBytes).digest("hex");
      const eligible={...artifact,name:`kg-audit-snapshot-${options.receipt.bundleId}`,size_in_bytes:archiveBytes.length,digest:`sha256:${sha256(archiveBytes)}`};
      const discovery=apiFor({artifacts:[eligible]});
      const api=async(path)=>{
        if(path === `/git/commits/${metadata.planCommit}`)return {sha:metadata.planCommit,tree:{sha:"1".repeat(40)}};
        if(path.startsWith("/git/trees/"))return {sha:"1".repeat(40),truncated:false,tree:[{path:"audit-production-plan.json",mode:"100644",type:"blob",sha:blobSha,size:planBytes.length}]};
        if(path.startsWith("/git/blobs/"))return {sha:blobSha,size:planBytes.length,encoding:"base64",content:planBytes.toString("base64")};
        return discovery(path);
      };
      const output=resolve(options.directory,"../"+options.receipt.bundleId+"-output");
      try {
        const result=await downloadAuditSnapshot({...options,client:{api,download:async()=>archiveBytes},outputDirectory:output});
        assert.equal(result.snapshotVerified,true);assert.equal(result.liveReleaseVerified,false);assert.equal(result.artifactId,5);
        assert.deepEqual(await readFile(resolve(output,"news.json")),Buffer.from("null\n"));
      } finally {await rm(output,{recursive:true,force:true});}
    } finally {await rm(archive,{force:true});}
  });
});

test("infrastructure bootstrap skips only when exact receipt bytes are unchanged",async()=>{
  const root=await mkdtemp(resolve(tmpdir(),"audit-bootstrap-"));
  try {
    const workflow=await readFile(resolve(".github/workflows/validate.yml"),"utf8");
    const code=workflow.split("node --input-type=module <<'NODE'\n")[1].split("          NODE")[0].split("\n").map((line)=>line.slice(10)).join("\n");
    const git=async(...args)=>(await execFile("git",args,{cwd:root})).stdout.trim();
    await git("init","-q");await mkdir(resolve(root,"data"));await writeFile(resolve(root,"data/accepted-release.json"),"{}\n");
    await git("add",".");await git("-c","user.name=Fixture","-c","user.email=f@example.invalid","commit","-qm","base");
    const base=await git("rev-parse","HEAD");await writeFile(resolve(root,"README"),"infra");await git("add",".");await git("-c","user.name=Fixture","-c","user.email=f@example.invalid","commit","-qm","infra");
    const head=await git("rev-parse","HEAD");
    const run=(sha)=>execFile(process.execPath,["--input-type=module","-e",code],{cwd:root,env:{...process.env,BASE_SHA:base,HEAD_SHA:sha,GITHUB_OUTPUT:resolve(root,"output")}});
    await run(head);assert.equal(await readFile(resolve(root,"output"),"utf8"),"verified=false\n");
    await writeFile(resolve(root,"data/accepted-release.json"),"{ }\n");await git("add","data");await git("-c","user.name=Fixture","-c","user.email=f@example.invalid","commit","-qm","changed");
    await assert.rejects(run(await git("rev-parse","HEAD")),/New migration requires/u);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("final live attestation persists exact combined head and receipt hash separately from production",async()=>{
  await fixture(async(options)=>{
    const path=resolve(options.directory,"snapshot.json"), snapshot=JSON.parse(await readFile(path));
    snapshot.operation="verify"; snapshot.verification={combinedHead:"9".repeat(40),proposalCommit,baseCommit,liveReceiptVerified:true,semanticReplayVerified:false,receiptSha256:sha256(canonicalJson(options.receipt))};
    await writeFile(path,encode(snapshot));
    assert.equal((await validateSnapshotDirectory(options)).verification.combinedHead,"9".repeat(40));
    snapshot.verification.receiptSha256="0".repeat(64);await writeFile(path,encode(snapshot));
    await assert.rejects(validateSnapshotDirectory(options),/evidence differs/u);
    snapshot.operation="produce";await writeFile(path,encode(snapshot));
    await assert.rejects(validateSnapshotDirectory(options),/production cannot/u);
  });
});
