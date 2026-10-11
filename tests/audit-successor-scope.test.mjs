import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../scripts/lib/candidate-bundle.mjs";
import { SUCCESSOR_SCOPE_SHA256, validateSuccessorAuthority, checkSuccessorFrozen, checkSuccessorGitFrozen, isSuccessorApiRequestAllowed } from "../scripts/lib/audit-successor-scope.mjs";
const scopeBytes=readFileSync("audit-recovery/reference-658/scope.json");
const scope=JSON.parse(scopeBytes), operatorCommit="a".repeat(40);
const policy=JSON.parse(readFileSync("audit-snapshots/policy.json"));
const authority={schemaVersion:1,kind:"explicit-same-release-successor-authority",scopeSha256:SUCCESSOR_SCOPE_SHA256,
  successorOrdinal:1,originalStateRemainsUnknown:true,purpose:"historical-convergence-only",operatorCommit,expectedMain:operatorCommit,
  authorizedAt:"2026-10-10T23:00:00.000Z",reason:"Synthetic test authorization, never production evidence"};
const encode=x=>Buffer.from(`${canonicalJson(x)}\n`);
const validate=(a=authority,s=scopeBytes)=>validateSuccessorAuthority({scopeBytes:s,authorityBytes:encode(a),operatorCommit,policy});
test("new authority binds exact old scope but current reviewed operator; original unknown bytes remain unchanged",()=>{
  const before=Buffer.from(scopeBytes);const result=validate();
  assert.equal(result.approval.expectedMain,operatorCommit);
  assert.equal(result.scope.plan.expectedMain,"871aec7774c4f3acb9c4f7591107c2131dba50df");
  assert.equal(result.approval.targetCommit,"418ab403c0871c806e7cadaa74737a736b72ab3a");
  assert.equal(result.approval.releaseId,409240538);
  assert.equal(result.scope.originalState,"unknown");
  assert.deepEqual(result.scope.originalFailure,{requestCode:"HTTP_ERROR",requestStatus:401});
  assert.equal(result.journal.pendingOperations.length,1);assert.deepEqual(scopeBytes,before);
});
test("old authorization, wrong operator, fabricated evidence or broader purpose cannot grant successor",()=>{
  for(const change of [{operatorCommit:"b".repeat(40)},{expectedMain:scope.plan.expectedMain},{purpose:"accept"},{originalStateRemainsUnknown:false},
    {successorOrdinal:2},{scopeSha256:"c".repeat(64)},{authorizedAt:null},{reason:""},{githubRequestId:"OLD:ID"}])assert.throws(()=>validate({...authority,...change}));
  for(const mutate of [s=>s.originalState="failed",s=>s.originalFailure.githubRequestId="A:B:C:D:E",s=>s.originalJournal="{}\n",
    s=>s.releaseId++,s=>s.plan.sourceCommit="d".repeat(40),s=>s.plan.proposalCommit="d".repeat(40),s=>s.plan.expectedMain=operatorCommit,
    s=>s.plan.files["manifest.json"].bytes++,s=>s.plan.migrationReview.reason="new review"]){const copy=structuredClone(scope);mutate(copy);assert.throws(()=>validate(authority,encode(copy)));}
});
function responses(){return {
  "/git/ref/heads/main":{ref:"refs/heads/main",object:{type:"commit",sha:operatorCommit}},
  [`/git/ref/${scope.plan.proposalRef.slice(5)}`]:{ref:scope.plan.proposalRef,object:{type:"commit",sha:scope.plan.proposalCommit}},
  [`/releases/${scope.releaseId}`]:{id:scope.releaseId,draft:true,immutable:false,target_commitish:scope.plan.proposalCommit,tag_name:`kg-audit-${scope.plan.bundleId}`},
  [`/compare/${scope.plan.expectedMain}...${operatorCommit}`]:{status:"ahead",merge_base_commit:{sha:scope.plan.expectedMain}}
};}
test("live successor checks exact main, proposal, draft identity and original-base ancestry",async()=>{
  const good=responses();await checkSuccessorFrozen({api:async p=>{
    assert.equal(isSuccessorApiRequestAllowed(p,"GET","converge"),true);
    return good[p];
  },scope,operatorCommit});
  for(const mutate of [r=>r["/git/ref/heads/main"].object.sha="b".repeat(40),r=>r[`/git/ref/${scope.plan.proposalRef.slice(5)}`].object.sha="b".repeat(40),
    r=>r[`/releases/${scope.releaseId}`].draft=false,r=>r[`/releases/${scope.releaseId}`].id++,r=>r[`/releases/${scope.releaseId}`].target_commitish=operatorCommit,
    r=>r[`/compare/${scope.plan.expectedMain}...${operatorCommit}`].merge_base_commit.sha=operatorCommit]){
    const bad=responses();mutate(bad);await assert.rejects(checkSuccessorFrozen({api:async p=>bad[p],scope,operatorCommit}));
  }
});

test("only exact SHA compare GET bypasses the dot guard; history never gains a mutation",()=>{
  const compare=`/compare/${scope.plan.expectedMain}...${operatorCommit}`;
  assert.equal(isSuccessorApiRequestAllowed(compare,"GET","history"),true);
  assert.equal(isSuccessorApiRequestAllowed(compare,"POST","converge"),false);
  for(const path of ["/../git/refs","/compare/main...HEAD",compare+"/extra",compare+"?page=1",compare.replace("...",".."),
    "/git/%2e%2e/refs","/git/refs#fragment","/git/refs\\other","https://api.github.com/git/refs"])
    assert.equal(isSuccessorApiRequestAllowed(path,"GET","history"),false,path);
  for(const path of ["/git/blobs","/git/trees","/git/commits","/git/refs"]){
    assert.equal(isSuccessorApiRequestAllowed(path,"POST","history"),false);
    assert.equal(isSuccessorApiRequestAllowed(path,"POST","converge"),true);
  }
  for(const method of ["POST","PATCH","DELETE"])
    assert.equal(isSuccessorApiRequestAllowed("/releases/409240538",method,"converge"),false);
});
test("successor isolation never runs proposal code with a write token or exports trusted PR snapshot",()=>{
  const workflow=readFileSync(".github/workflows/audit-successor.yml","utf8");
  assert.match(workflow,/github.ref == 'refs\/heads\/main'/u);
  assert.match(workflow,/github.run_attempt == 1/u);
  const [build,writer]=workflow.split("\n  converge:\n");
  assert.match(build,/contents: read/u);assert.doesNotMatch(build,/contents: write/u);
  const container=build.split("          docker run")[1].split("      - uses:")[0];
  assert.doesNotMatch(container,/GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN/u);
  assert.match(container,/operator:ro/u);assert.match(container,/approved:ro/u);assert.match(container,/max-old-space-size=4096/u);
  assert.match(writer,/contents: write/u);assert.match(writer,/persist-credentials: false/u);
  assert.doesNotMatch(writer,/npm |run:.*proposal|kg-audit-snapshot-|verified-snapshot/u);
  assert.match(writer,/historical-upload-convergence-409240538/u);
  assert.match(readFileSync("scripts/prepare-migration-pr.mjs","utf8"),/process.env.GITHUB_ACTIONS === "true"/u);
});

test("history checks only public Git; the writer still rejects inaccessible or changed draft",async()=>{
  const calls=[],good=responses();
  const readOnlyApi=async p=>{calls.push(p);assert.equal(isSuccessorApiRequestAllowed(p,"GET","history"),true);return good[p];};
  await checkSuccessorGitFrozen({api:readOnlyApi,scope,operatorCommit});
  assert.equal(calls.length,3);assert.ok(calls.every(p=>!p.startsWith("/releases")));
  assert.equal(isSuccessorApiRequestAllowed(`/releases/${scope.releaseId}`,"GET","history"),false);
  await assert.rejects(checkSuccessorFrozen({api:readOnlyApi,scope,operatorCommit}));
});
