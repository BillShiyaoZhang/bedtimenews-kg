import assert from "node:assert/strict";
import test from "node:test";
import { createAuditProductionJournal } from "../scripts/lib/audit-production-journal.mjs";
const plan = { repository: "fixture/repo", bundleId: "a".repeat(64), proposalCommit: "b".repeat(40), files: { "manifest.json": { bytes: 5, sha256: "c".repeat(64) } } };
function fixture() {
  const refs=new Map(),objects=new Map(); let serial=0, writes=0, lose=false;
  const api=async(path,{method="GET",body,missing=false}={})=>{
    if(method === "GET") {
      const value=path.startsWith("/git/ref/")?refs.get(path.slice(9)):objects.get(path);
      if(!value && missing)return null;
      assert.ok(value,`Missing ${path}`);return structuredClone(value);
    }
    writes++; const sha=(++serial).toString(16).padStart(40,"0");
    if(path === "/git/blobs")objects.set(`/git/blobs/${sha}`,{encoding:"base64",content:Buffer.from(body.content).toString("base64"),size:Buffer.byteLength(body.content)});
    else if(path === "/git/trees")objects.set(`/git/trees/${sha}`,{truncated:false,tree:body.tree});
    else if(path === "/git/commits")objects.set(`/git/commits/${sha}`,{tree:{sha:body.tree}});
    else if(path === "/git/refs") {
      const key=body.ref.slice(5); assert.ok(!refs.has(key),"Refs are create-only");
      refs.set(key,{ref:body.ref,object:{type:"commit",sha:body.sha}});
      if(lose) { lose=false;throw Error("Unknown create response"); }
    } else throw Error("Unexpected mutation");
    return {sha};
  };
  const options={api,plan,planSha256:"d".repeat(64),producer:{runId:1},checkFrozen:async()=>{}};
  const operation={operation:`kg-audit-${plan.bundleId}:create`,action:"create",repository:plan.repository,bundleId:plan.bundleId,targetCommit:plan.proposalCommit};
  return {options,operation,writes:()=>writes,lose:()=>{lose=true;}};
}
test("normal-stage durable intent survives runner loss and forbids a repeated mutation",async()=>{
  const f=fixture(),journal=await createAuditProductionJournal(f.options);
  await journal.onMutationIntent(f.operation);
  const after=f.writes(),restart=await createAuditProductionJournal({...f.options,producer:{runId:2}});
  assert.deepEqual(restart.pendingOperations,[f.operation.operation]);
  await assert.rejects(restart.onMutationIntent(f.operation)); assert.equal(f.writes(),after);
  await restart.onMutationReconciled(f.operation);
  const complete=await createAuditProductionJournal(f.options); assert.deepEqual(complete.pendingOperations,[]);
  await assert.rejects(complete.onMutationIntent(f.operation));
});
test("unknown intent ref response stops caller and is read-only reconciled on restart",async()=>{
  const f=fixture(),journal=await createAuditProductionJournal(f.options); f.lose();
  await assert.rejects(journal.onMutationIntent(f.operation),/Unknown/u);
  const writes=f.writes(),restart=await createAuditProductionJournal(f.options);
  assert.equal(f.writes(),writes); assert.deepEqual(restart.pendingOperations,[f.operation.operation]);
  await assert.rejects(restart.onMutationIntent(f.operation));
});
test("different plan cannot take over prior operation journal",async()=>{
  const f=fixture(),journal=await createAuditProductionJournal(f.options); await journal.onMutationIntent(f.operation);
  await assert.rejects(createAuditProductionJournal({...f.options,planSha256:"e".repeat(64)}));
});
test("frozen main failure prevents any durable reservation",async()=>{
  const f=fixture(),journal=await createAuditProductionJournal({...f.options,checkFrozen:async()=>{throw Error("main moved");}});
  await assert.rejects(journal.onMutationIntent(f.operation),/main moved/u); assert.equal(f.writes(),0);
});

test("concurrent producers acquire at most one permission for the same operation",async()=>{
  const f=fixture();
  const first=await createAuditProductionJournal(f.options),second=await createAuditProductionJournal({...f.options,producer:{runId:2}});
  const outcomes=await Promise.allSettled([first.onMutationIntent(f.operation),second.onMutationIntent(f.operation)]);
  assert.equal(outcomes.filter((r)=>r.status === "fulfilled").length,1);
  assert.equal(outcomes.filter((r)=>r.status === "rejected").length,1);
});
