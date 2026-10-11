import { canonicalJson } from "./candidate-bundle.mjs";
import { ALLOWED_ACCEPTED_PATHS, validateAcceptedReleaseStructure } from "./accepted-release.mjs";
const must = (v) => { if (!v) throw new Error("Live audit combined-head binding rejected"); };
const sourcePath = "sources/bedtimenews-archive-contents";
const commitSha = /^[a-f0-9]{40}$/u;
const paths = new Set(["data/accepted-release.json", ...ALLOWED_ACCEPTED_PATHS]);
// Strict canonical prepare shape: one parent P, accepted outputs and the exact reviewed source gitlink.
// The ordinary PR gate independently replays all semantics; this GET-only
// premerge check binds a fresh live receipt to that exact reviewed combined head.
export async function verifyLiveCombinedHead({ api, plan, combinedHead, receipt }) {
  must([combinedHead, plan.proposalCommit, plan.expectedMain, plan.sourceCommit].every((sha) => commitSha.test(sha ?? "")));
  const proposal = await api(`/git/commits/${plan.proposalCommit}`), combined = await api(`/git/commits/${combinedHead}`);
  must(proposal.sha === plan.proposalCommit && combined.sha === combinedHead && combined.parents.length === 1 && combined.parents[0].sha === plan.proposalCommit);
  const entries = async (commit) => {
    const tree = await api(`/git/trees/${commit.tree.sha}?recursive=1`);
    must(tree.truncated === false && Array.isArray(tree.tree));
    return new Map(tree.tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry]));
  };
  const before = await entries(proposal), after = await entries(combined);
  const originalSource = before.get(sourcePath), acceptedSource = after.get(sourcePath);
  must(originalSource?.type === "commit" && originalSource.mode === "160000" && commitSha.test(originalSource.sha ?? ""));
  must(acceptedSource?.type === "commit" && acceptedSource.mode === "160000" && acceptedSource.sha === plan.sourceCommit);
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (path === sourcePath) continue;
    if (paths.has(path)) { must(after.get(path)?.type === "blob" && after.get(path)?.mode === "100644"); continue; }
    must(canonicalJson(before.get(path) ?? null) === canonicalJson(after.get(path) ?? null));
  }
  const entry = after.get("data/accepted-release.json"); must(entry && entry.size <= 1024 * 1024);
  const blob = await api(`/git/blobs/${entry.sha}`); must(blob.encoding === "base64" && blob.size <= 1024 * 1024);
  const bytes = Buffer.from(blob.content,"base64"), accepted = JSON.parse(bytes); validateAcceptedReleaseStructure(accepted);
  must(bytes.length === blob.size && bytes.equals(Buffer.from(`${canonicalJson(accepted)}\n`)) && accepted.mode === "migration"
    && accepted.predecessor.commit === plan.expectedMain && accepted.codeCommit === plan.proposalCommit && accepted.source.commit === plan.sourceCommit
    && accepted.candidateBundleId === plan.bundleId && canonicalJson(accepted.auditReceipt) === canonicalJson(receipt));
  return { combinedHead, proposalCommit: plan.proposalCommit, baseCommit: plan.expectedMain, liveReceiptVerified: true, semanticReplayVerified: false };
}
