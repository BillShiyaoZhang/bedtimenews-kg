// Trusted main only; frozen incident data and independently rebuilt files are
// data, never imports. No dependency installation runs in this token-bearing job.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalJson, sha256 } from "./lib/candidate-bundle.mjs";
import { SUCCESSOR_WORKFLOW, validateSuccessorAuthority, checkSuccessorFrozen, isSuccessorApiRequestAllowed } from "./lib/audit-successor-scope.mjs";
import { createGitHubReleaseStore, prepareAuditBundle } from "./lib/release-store.mjs";
import { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint } from "./lib/accepted-git.mjs";
import { createActionsUploadFence } from "./lib/actions-upload-fence.mjs";
import { boundedUploadFailure, runActionsAuditUpload, createObservedUploadTransport } from "./lib/actions-audit-upload.mjs";
const must = (v) => { if (!v) throw new Error("ADAPTER_REJECTED"); };
try {
  const env=process.env, root=resolve(import.meta.dirname,".."), [mode,dir]=process.argv.slice(2);
  must(["history","converge"].includes(mode) && dir && process.argv.length === 4);
  const directory=resolve(dir), policy=JSON.parse(await readFile(resolve(root,"audit-snapshots/policy.json")));
  must(env.GITHUB_ACTIONS === "true" && env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_RUN_ATTEMPT === "1"
    && env.GITHUB_REF === "refs/heads/main" && env.GITHUB_REPOSITORY === policy.repository
    && env.GITHUB_SHA === env.GITHUB_WORKFLOW_SHA && /^[a-f0-9]{40}$/u.test(env.GITHUB_SHA)
    && env.GITHUB_WORKFLOW_REF === `${policy.repository}/${SUCCESSOR_WORKFLOW}@refs/heads/main`
    && env.GITHUB_ACTOR === policy.actor.login && env.GITHUB_TRIGGERING_ACTOR === policy.actor.login && env.GITHUB_ACTOR_ID === String(policy.actor.id)
    && process.versions.node === "22.23.2" && new Intl.DateTimeFormat().resolvedOptions().locale === "en-US"
    && new Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC");
  must(execFileSync("git",["--no-replace-objects","-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim() === env.GITHUB_SHA);
  const event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH));
  must(/^[a-f0-9]{40}$/u.test(event.inputs?.authority_commit) && /^[a-f0-9]{64}$/u.test(event.inputs?.authority_sha256));
  const api=async(path,{method="GET",body,missing=false,status}={})=>{
    must(isSuccessorApiRequestAllowed(path, method, mode));
    const r=await fetch(`https://api.github.com/repos/${policy.repository}${path}`,{method,redirect:"error",signal:AbortSignal.timeout(30_000),
      headers:{Authorization:`Bearer ${env.GH_TOKEN}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2026-03-10",...(body?{"Content-Type":"application/json"}:{})},...(body?{body:canonicalJson(body)}:{})});
    if(missing && r.status===404)return null;
    must(status?r.status===status:r.ok);
    let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.length;must(size<=4*1024*1024);chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks));
  };
  // Authority is a separately approved Git data blob, not executable checkout.
  const record=await api(`/git/commits/${event.inputs.authority_commit}`);
  must(record.sha===event.inputs.authority_commit && /^[a-f0-9]{40}$/u.test(record.tree?.sha));
  const tree=await api(`/git/trees/${record.tree.sha}`);
  must(tree.sha===record.tree.sha && tree.truncated===false);
  const matches=tree.tree.filter(e=>e.path==="audit-successor-authority.json");
  must(matches.length===1 && matches[0].type==="blob" && matches[0].mode==="100644" && matches[0].size<=16384);
  const blob=await api(`/git/blobs/${matches[0].sha}`);must(blob.encoding==="base64" && blob.size<=16384);
  const authorityBytes=Buffer.from(blob.content,"base64");must(authorityBytes.length===blob.size && sha256(authorityBytes)===event.inputs.authority_sha256);
  const scopeBytes=await readFile(resolve(root,"audit-recovery/reference-658/scope.json"));
  const {scope,authority,journal,approval,uploadScope}=validateSuccessorAuthority({scopeBytes,authorityBytes,operatorCommit:env.GITHUB_SHA,policy});
  const run=await api(`/actions/runs/${env.GITHUB_RUN_ID}`);
  must(String(run.id)===env.GITHUB_RUN_ID && run.run_attempt===1 && run.head_sha===env.GITHUB_SHA && run.head_branch==="main"
    && run.event==="workflow_dispatch" && run.path===SUCCESSOR_WORKFLOW && run.actor.id===policy.actor.id
    && run.triggering_actor.id===policy.actor.id && run.repository.full_name===policy.repository && run.head_repository.full_name===policy.repository);
  const checkFrozen=()=>checkSuccessorFrozen({api,scope,operatorCommit:env.GITHUB_SHA});await checkFrozen();
  const [owner,repo]=policy.repository.split("/");
  if(mode==="history"){
    // Only this explicitly historical path admits the frozen accepted ancestor;
    // checkSuccessorFrozen has already bound live main and its exact ancestry.
    const checkpoint=await readVerifiedAcceptedCheckpoint(await loadAcceptedGitCheckpoint({root,repository:policy.repository,commit:scope.plan.expectedMain,allowAncestor:true}));
    // This historical reconstruction does not trust current-main candidate state.
    const readOnlyFetch=(url,options={})=>{must(["GET","HEAD"].includes(options.method??"GET"));return fetch(url,options);};
    const downloaded=await createGitHubReleaseStore({owner,repo,token:env.GH_TOKEN,fetchImpl:readOnlyFetch}).readBundle({receipt:checkpoint.manifest.auditReceipt});
    await mkdir(directory);await mkdir(resolve(directory,"checkpoint"));
    for(const [name,bytes]of downloaded.files)await writeFile(resolve(directory,"checkpoint",name),bytes,{flag:"wx"});
    await writeFile(resolve(directory,"plan.json"),`${canonicalJson(scope.plan)}\n`,{flag:"wx"});
    await writeFile(resolve(directory,"migration-review.json"),`${canonicalJson(scope.plan.migrationReview)}\n`,{flag:"wx"});
    await checkFrozen();
  }else{
    must(env.KG_RELEASE_ACTIVATED==="true" && env.KG_RELEASE_STORAGE_APPROVED===policy.repository);
    const bundle=await prepareAuditBundle(directory);
    must(bundle.bundleId===scope.plan.bundleId && Object.keys(bundle.files).length===7);
    for(const [name,file]of Object.entries(scope.plan.files))must(bundle.files[name].sha256===file.sha256 && bundle.files[name].bytes===file.bytes);
    const fence=createActionsUploadFence({api,scope:uploadScope,run:{id:run.id,attempt:1,workflowSha:env.GITHUB_SHA},authoritySha256:sha256(authorityBytes)});
    await fence.retainEvidence({kind:"original-unknown-upload",scope,authority,authorityCommit:event.inputs.authority_commit,authoritySha256:sha256(authorityBytes)});
    const observed=createObservedUploadTransport({scope:uploadScope});
    const receipt=await runActionsAuditUpload({scope:uploadScope,priorApproval:approval,journal,bundleDir:directory,checkFrozen,fence,
      assertHealthy:observed.assertHealthy,createStore:options=>createGitHubReleaseStore({owner,repo,token:env.GH_TOKEN,fetchImpl:observed.fetchImpl,...options})});
    // Another complete live GET-only read is mandatory; receipt is historical
    // convergence evidence, never a trusted PR snapshot or accepted release.
    const downloaded=await createGitHubReleaseStore({owner,repo,token:env.GH_TOKEN,fetchImpl:(url,options={})=>{
      must(["GET","HEAD"].includes(options.method??"GET"));return fetch(url,options);
    }}).readBundle({receipt});must(downloaded.files.size===7);await checkFrozen();
    const result={kind:"historical-upload-convergence",originalState:"unknown",originalJournalSha256:scope.originalJournalSha256,
      authoritySha256:sha256(authorityBytes),receipt,accepted:false,snapshotEligible:false};
    await fence.retainEvidence(result);
    const output=resolve(directory,"../successor-result");await mkdir(output);
    await writeFile(resolve(output,"result.json"),`${canonicalJson(result)}\n`,{flag:"wx"});
    console.log(JSON.stringify({status:"historical-convergence-verified",releaseId:receipt.releaseId,assets:7,accepted:false}));
  }
}catch(error){console.error(JSON.stringify({status:"stopped",...boundedUploadFailure(error)}));process.exitCode=1;}
