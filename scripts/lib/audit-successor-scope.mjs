import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { validateProductionPlan } from "./audit-snapshot.mjs";
export const SUCCESSOR_SCOPE_SHA256 = "d747f01f410612eb876748fd7c6cddcb97dde7c38d64f47bfba727b4adf19f9d";
export const SUCCESSOR_WORKFLOW = ".github/workflows/audit-successor.yml";
const must = (v) => { if (!v) throw new Error("Successor authority rejected"); };
const same = (a,b) => canonicalJson(a) === canonicalJson(b);
const commit = (v) => /^[a-f0-9]{40}$/u.test(v);

// This adapter supports exactly the retained 658 incident. An authority for a
// different upload requires a new code review, not caller-selected scope data.
export function validateSuccessorAuthority({ scopeBytes, authorityBytes, operatorCommit, policy }) {
  must(Buffer.isBuffer(scopeBytes) && sha256(scopeBytes) === SUCCESSOR_SCOPE_SHA256);
  const scope = JSON.parse(scopeBytes), authority = JSON.parse(authorityBytes);
  must(scopeBytes.equals(Buffer.from(`${canonicalJson(scope)}\n`)) && authorityBytes.equals(Buffer.from(`${canonicalJson(authority)}\n`)));
  validateProductionPlan(scope.plan,{policy,baseCommit:scope.plan.expectedMain});
  must(same(Object.keys(authority).sort(),["authorizedAt","expectedMain","kind","operatorCommit","originalStateRemainsUnknown","purpose","reason","schemaVersion","scopeSha256","successorOrdinal"]));
  must(authority.schemaVersion === 1 && authority.kind === "explicit-same-release-successor-authority"
    && authority.scopeSha256 === SUCCESSOR_SCOPE_SHA256 && authority.successorOrdinal === 1
    && authority.originalStateRemainsUnknown === true && authority.purpose === "historical-convergence-only"
    && commit(operatorCommit) && authority.operatorCommit === operatorCommit && authority.expectedMain === operatorCommit
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(authority.authorizedAt) && Number.isFinite(Date.parse(authority.authorizedAt))
    && typeof authority.reason === "string" && authority.reason.trim().length > 0 && authority.reason.length <= 4096);
  must(scope.originalState === "unknown" && same(scope.originalFailure,{requestCode:"HTTP_ERROR",requestStatus:401})
    && sha256(scope.originalJournal) === scope.originalJournalSha256);
  const journal = JSON.parse(scope.originalJournal), plan = scope.plan;
  const file = plan.files["manifest.json"], assetName = `${file.sha256}-manifest.json`, tag = `kg-audit-${plan.bundleId}`;
  const operation = `${tag}:upload:${assetName}`;
  must(journal.schemaVersion === 1 && journal.repository === policy.repository && journal.candidate.bundleId === plan.bundleId
    && journal.candidate.targetCommit === plan.proposalCommit && same(journal.pendingOperations,[operation]));
  const approval = { schemaVersion:1,kind:"same-target-upload-convergence",operation,action:"upload",repository:scope.repository,
    tag,bundleId:plan.bundleId,targetCommit:plan.proposalCommit,manifestSha256:file.sha256,releaseId:scope.releaseId,
    asset:{name:assetName,bytes:file.bytes,sha256:file.sha256},expectedMain:operatorCommit,proposalRef:plan.proposalRef,
    recoveryCodeCommit:operatorCommit,originalJournalPath:scope.originalJournalPath,
    recoveryDirectory:"/actions-create-only-ref-fence/reference-658",originalJournalSha256:scope.originalJournalSha256,
    reviewedAt:authority.authorizedAt,reason:authority.reason };
  return {scope,authority,journal,approval,uploadScope:{...scope,...plan,expectedMain:operatorCommit}};
}

export async function checkSuccessorFrozen({ api, scope, operatorCommit }) {
  const plan = scope.plan;
  const [main,proposal,release,ancestry] = await Promise.all([
    api("/git/ref/heads/main"),api(`/git/ref/${plan.proposalRef.slice(5)}`),api(`/releases/${scope.releaseId}`),
    api(`/compare/${plan.expectedMain}...${operatorCommit}`)]);
  must(main.ref === "refs/heads/main" && main.object?.type === "commit" && main.object.sha === operatorCommit
    && proposal.ref === plan.proposalRef && proposal.object?.type === "commit" && proposal.object.sha === plan.proposalCommit
    && release.id === scope.releaseId && release.draft === true && !release.immutable
    && release.target_commitish === plan.proposalCommit && release.tag_name === `kg-audit-${plan.bundleId}`
    && ancestry.merge_base_commit?.sha === plan.expectedMain && ["ahead","identical"].includes(ancestry.status));
}
