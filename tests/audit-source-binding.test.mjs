import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { acceptedReleaseIdentity, validateAcceptedReleaseStructure } from "../scripts/lib/accepted-release.mjs";
import { verifyLiveCombinedHead } from "../scripts/lib/audit-live-verification.mjs";
import { checkoutAuditSource, verifyAuditSourceCheckout, AUDIT_SOURCE_PATH, AUDIT_SOURCE_URL } from "../scripts/lib/audit-source-checkout.mjs";
const hash = (value) => sha256(canonicalJson(value));
const oid = (digit) => digit.repeat(40);
const git = (...args) => execFileSync("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", ...args], {encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const commit = (root) => { git("-C",root,"add","."); git("-C",root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","fixture"); return git("-C",root,"rev-parse","HEAD"); };
async function checkoutFixture(t) {
  const base = await mkdtemp(resolve(tmpdir(),"audit-source-binding-")); t.after(()=>rm(base,{recursive:true,force:true}));
  const upstream=resolve(base,"upstream"),root=resolve(base,"proposal");
  await mkdir(upstream);git("init","-q",upstream); await writeFile(resolve(upstream,"news.md"),"old source\n"); const original=commit(upstream);
  await writeFile(resolve(upstream,"news.md"),"reviewed new source\n"); const sourceCommit=commit(upstream);
  await mkdir(root);git("init","-q",root);
  await writeFile(resolve(root,".gitmodules"),`[submodule "${AUDIT_SOURCE_PATH}"]\npath = ${AUDIT_SOURCE_PATH}\nurl = ${AUDIT_SOURCE_URL}\n`);
  git("-C",root,"add",".gitmodules");
  git("-C",root,"update-index","--add","--cacheinfo",`160000,${original},${AUDIT_SOURCE_PATH}`);
  git("-C",root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","proposal");
  const proposalCommit=git("-C",root,"rev-parse","HEAD");git("-C",root,"update-ref","refs/remotes/origin/main",proposalCommit);
  const plan={proposalCommit,expectedMain:proposalCommit,sourceCommit};const calls=[];
  const run=(args)=>{
    calls.push(args);
    if(args[0]==="clone") {
      assert.deepEqual(args.slice(0,4),["clone","--no-checkout","--",AUDIT_SOURCE_URL]);
      const answer=git(...args.map((arg)=>arg===AUDIT_SOURCE_URL?upstream:arg));
      git("-C",resolve(root,AUDIT_SOURCE_PATH),"remote","set-url","origin",AUDIT_SOURCE_URL);return answer;
    }
    return git(...args);
  };
  return {root,plan,run,calls};
}
test("credential-free checkout advances the exact reviewed source independently of proposal gitlink",async(t)=>{
  const f=await checkoutFixture(t);await checkoutAuditSource({...f,env:{}});
  assert.equal(git("-C",resolve(f.root,AUDIT_SOURCE_PATH),"rev-parse","HEAD"),f.plan.sourceCommit);
  verifyAuditSourceCheckout({...f,env:{}});
  git("-C",resolve(f.root,AUDIT_SOURCE_PATH),"remote","set-url","origin","https://example.invalid/unreviewed.git");
  assert.throws(()=>verifyAuditSourceCheckout({...f,env:{}}),/binding rejected/u);
  git("-C",resolve(f.root,AUDIT_SOURCE_PATH),"remote","set-url","origin",AUDIT_SOURCE_URL);
  await writeFile(resolve(f.root,AUDIT_SOURCE_PATH,"news.md"),"unreviewed edit\n");
  assert.throws(()=>verifyAuditSourceCheckout({...f,env:{}}),/binding rejected/u);
});
for(const name of ["sourceCommit","proposalCommit","expectedMain"]) test(`checkout rejects wrong ${name}`,async(t)=>{
  const f=await checkoutFixture(t);await assert.rejects(checkoutAuditSource({...f,plan:{...f.plan,[name]:oid("9")},env:{}}));
});
test("checkout refuses tokens before git operations",async(t)=>{
  const f=await checkoutFixture(t);
  for(const key of ["GH_TOKEN","GITHUB_TOKEN","ACTIONS_RUNTIME_TOKEN","ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) await assert.rejects(checkoutAuditSource({...f,env:{[key]:"fixture"}}),/binding rejected/u);
  assert.equal(f.calls.length,0);
});
test("checkout rejects proposal source URL substitution and symlink destination",async(t)=>{
  const f=await checkoutFixture(t);
  const altered=(args)=>args.includes("--get")&&args.at(-1).endsWith(".url")?"https://example.invalid/untrusted.git":f.run(args);
  await assert.rejects(checkoutAuditSource({...f,run:altered,env:{}}),/binding rejected/u);
  assert.equal(f.calls.some((args)=>args[0]==="clone"),false);
  await symlink(tmpdir(),resolve(f.root,"sources"));
  await assert.rejects(checkoutAuditSource({...f,env:{}}),/binding rejected/u);
});
async function liveFixture() {
  // Derive a structurally valid migration receipt from committed fixture data.
  // This is only a transport-binding fixture; semantic replay remains a separate gate.
  const accepted=JSON.parse(await readFile(new URL("../data/accepted-release.json",import.meta.url)));
  accepted.mode="migration";
  const to={configuration:accepted.configuration,runtime:accepted.runtime,versions:accepted.versions};
  const from=structuredClone(to);from.versions.extraction="fixture-previous";
  const review={schemaVersion:1,kind:"semantic-migration",baseline:{releaseId:accepted.predecessor.releaseId,bundleId:accepted.predecessor.bundleId},from,to,fromHash:hash(from),toHash:hash(to),diffHash:"d".repeat(64),archiveCommit:accepted.source.commit,observedInventoryHash:accepted.inventories.observed.sha256,sourceReviewHash:"e".repeat(64),reviewedAt:"2026-01-01T00:00:00Z",reason:"Fixture reviewed migration"};
  accepted.transition={kind:"reviewed-semantic-migration",review,sha256:hash(review)};
  accepted.releaseId=acceptedReleaseIdentity(accepted);validateAcceptedReleaseStructure(accepted);
  const combinedHead=oid("a"),plan={proposalCommit:accepted.codeCommit,expectedMain:accepted.predecessor.commit,sourceCommit:accepted.source.commit,bundleId:accepted.candidateBundleId};
  const data=Buffer.from(`${canonicalJson(accepted)}\n`);
  const receiptEntry={path:"data/accepted-release.json",type:"blob",mode:"100644",sha:oid("b"),size:data.length};
  const sourceEntry={path:AUDIT_SOURCE_PATH,type:"commit",mode:"160000",sha:oid("1")};
  const codeEntry={path:"scripts/generator.mjs",type:"blob",mode:"100644",sha:oid("2"),size:10};
  const before=[sourceEntry,codeEntry,{...receiptEntry,sha:oid("3")}];const after=[{...sourceEntry,sha:plan.sourceCommit},codeEntry,receiptEntry];
  const commits=new Map([[plan.proposalCommit,{sha:plan.proposalCommit,tree:{sha:oid("4")},parents:[{sha:plan.expectedMain}]}],[combinedHead,{sha:combinedHead,tree:{sha:oid("5")},parents:[{sha:plan.proposalCommit}]}]]);
  const api=async(path)=>{
    if(path.startsWith("/git/commits/")) return commits.get(path.split("/").at(-1));
    if(path===`/git/trees/${oid("4")}?recursive=1`)return {truncated:false,tree:before};
    if(path===`/git/trees/${oid("5")}?recursive=1`)return {truncated:false,tree:after};
    if(path===`/git/blobs/${receiptEntry.sha}`) return {encoding:"base64",content:data.toString("base64"),size:data.length};
    throw Error(`Unexpected API path ${path}`);
  };
  return {api,plan,combinedHead,receipt:accepted.auditReceipt,before,after,commits};
}
test("live verifier accepts only the plan source advance with exact receipt/main/proposal",async()=>{
  const f=await liveFixture();assert.equal((await verifyLiveCombinedHead(f)).liveReceiptVerified,true);
  for(const field of ["sourceCommit","expectedMain","proposalCommit"]) await assert.rejects(verifyLiveCombinedHead({...f,plan:{...f.plan,[field]:oid("9")}}));
  await assert.rejects(verifyLiveCombinedHead({...f,receipt:{...f.receipt,releaseId:f.receipt.releaseId+1}}));
});
for(const variant of ["wrong-source","blob-source","wrong-mode","missing-source","invalid-original","changed-code","new-code","wrong-parent"]) test(`live verifier refuses ${variant}`,async()=>{
  const f=await liveFixture();
  if(variant==="wrong-source") f.after[0].sha=oid("9");
  if(variant==="blob-source") f.after[0].type="blob";
  if(variant==="wrong-mode") f.after[0].mode="100644";
  if(variant==="missing-source") f.after.shift();
  if(variant==="invalid-original") f.before[0].type="blob";
  if(variant==="changed-code") f.after[1]={...f.after[1],sha:oid("9")};
  if(variant==="new-code") f.after.push({path:"scripts/unreviewed.mjs",type:"blob",mode:"100644",sha:oid("9"),size:1});
  if(variant==="wrong-parent") f.commits.get(f.combinedHead).parents=[{sha:oid("9")}];
  await assert.rejects(verifyLiveCombinedHead(f),/binding rejected/u);
});

test("live verifier also accepts an already correct source gitlink without broadening other submodule changes",async()=>{
  const f=await liveFixture();f.before[0].sha=f.plan.sourceCommit;
  assert.equal((await verifyLiveCombinedHead(f)).liveReceiptVerified,true);
  f.after.push({path:"sources/unreviewed",type:"commit",mode:"160000",sha:oid("8")});
  await assert.rejects(verifyLiveCombinedHead(f),/binding rejected/u);
});
test("trusted workflow checks out fixed source before running any proposal npm code",async()=>{
  const workflow=await readFile(new URL("../.github/workflows/audit-snapshot.yml",import.meta.url),"utf8");
  assert.ok(workflow.indexOf("node /operator/scripts/lib/audit-source-checkout.mjs /build/proposal") < workflow.indexOf("npm ci"));
  assert.doesNotMatch(workflow,/submodule update/u);
  assert.doesNotMatch(workflow,/-e (?:GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN)/u);
});
