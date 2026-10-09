import { canonicalJson } from "./candidate-bundle.mjs";
import { ALLOWED_ACCEPTED_PATHS, validateAcceptedReleaseStructure } from "./accepted-release.mjs";
const must = (v) => { if (!v) throw new Error("Live audit combined-head binding rejected"); };
const paths = new Set(["data/accepted-release.json", ...ALLOWED_ACCEPTED_PATHS]);
// Strict canonical prepare shape: one parent P, only accepted output changes.
// The ordinary PR gate independently replays all semantics; this GET-only
// premerge check binds a fresh live receipt to that exact reviewed combined head.
export async function verifyLiveCombinedHead({ api, plan, combinedHead, receipt }) {
  must(/^[a-f0-9]{40}$/u.test(combinedHead));
  const proposal = await api(`/git/commits/${plan.proposalCommit}`), combined = await api(`/git/commits/${combinedHead}`);
  must(proposal.sha === plan.proposalCommit && combined.sha === combinedHead && combined.parents.length === 1 && combined.parents[0].sha === plan.proposalCommit);
  const entries = async (commit) => {
    const tree = await api(`/git/trees/${commit.tree.sha}?recursive=1`);
    must(tree.truncated === false && Array.isArray(tree.tree));
    return new Map(tree.tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry]));
  };
  const before = await entries(proposal), after = await entries(combined);
  for (const path of new Set([...before.keys(), ...after.keys()])) {
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
