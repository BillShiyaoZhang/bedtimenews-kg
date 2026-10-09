import { canonicalJson, sha256 } from "./candidate-bundle.mjs";

const must = (value) => { if (!value) throw new Error("Audit production journal rejected"); };
// A durable, create-only operation ledger for normal production. It does not
// fabricate a successor, forget a pending operation or reset a retry budget.
export async function createAuditProductionJournal({ api, plan, planSha256, producer, checkFrozen }) {
  const prefix = `tags/kg-audit-production-${plan.bundleId}`;
  async function readRecord(suffix) {
    const ref = await api(`/git/ref/${prefix}-${suffix}`, { missing: true });
    if (!ref) return null;
    must(ref.ref === `refs/${prefix}-${suffix}` && ref.object?.type === "commit");
    const commit = await api(`/git/commits/${ref.object.sha}`);
    const tree = await api(`/git/trees/${commit.tree.sha}`);
    must(tree.truncated === false && tree.tree.length === 1 && tree.tree[0].path === "record.json" && tree.tree[0].mode === "100644");
    const blob = await api(`/git/blobs/${tree.tree[0].sha}`);
    must(blob.encoding === "base64" && blob.size <= 128 * 1024);
    const bytes = Buffer.from(blob.content, "base64"), value = JSON.parse(bytes);
    must(bytes.length === blob.size && bytes.equals(Buffer.from(`${canonicalJson(value)}\n`)));
    return value;
  }
  async function append(suffix, value) {
    const blob = await api("/git/blobs", { method: "POST", body: { encoding: "utf-8", content: `${canonicalJson(value)}\n` } });
    const tree = await api("/git/trees", { method: "POST", body: { tree: [{ path: "record.json", mode: "100644", type: "blob", sha: blob.sha }] } });
    const commit = await api("/git/commits", { method: "POST", body: { message: "Retain reviewed audit production evidence", tree: tree.sha, parents: [] } });
    // No retry after an unknown ref creation result. A later read may reconcile
    // success but never authorizes repeating the underlying release mutation.
    await api("/git/refs", { method: "POST", body: { ref: `refs/${prefix}-${suffix}`, sha: commit.sha } });
    must(canonicalJson(await readRecord(suffix)) === canonicalJson(value));
  }
  const tag = `kg-audit-${plan.bundleId}`;
  const operations = [`${tag}:create`, ...Object.entries(plan.files).map(([name, binding]) => `${tag}:upload:${binding.sha256}-${name}`)];
  const intents = new Map(), outcomes = new Set();
  for (const operation of operations) {
    const key = sha256(operation), intent = await readRecord(`intent-${key}`), outcome = await readRecord(`outcome-${key}`);
    must(!outcome || intent);
    if (intent) {
      must(intent.planSha256 === planSha256 && intent.operation.operation === operation && intent.operation.repository === plan.repository
        && intent.operation.bundleId === plan.bundleId && intent.operation.targetCommit === plan.proposalCommit);
      intents.set(operation, intent);
    }
    if (outcome) { must(outcome.intentSha256 === sha256(canonicalJson(intent)) && outcome.state === "positively-reconciled"); outcomes.add(operation); }
  }
  return Object.freeze({
    pendingOperations: [...intents.keys()].filter((operation) => !outcomes.has(operation)),
    async onMutationIntent(operation) {
      must(operations.includes(operation.operation) && !intents.has(operation.operation));
      must(operation.repository === plan.repository && operation.bundleId === plan.bundleId && operation.targetCommit === plan.proposalCommit);
      await checkFrozen();
      const intent = { schemaVersion: 1, kind: "audit-production-intent", planSha256, producer, operation };
      await append(`intent-${sha256(operation.operation)}`, intent);
      intents.set(operation.operation, intent);
      await checkFrozen();
    },
    async onMutationReconciled(operation) {
      const intent = intents.get(operation.operation); must(intent);
      if (outcomes.has(operation.operation)) return;
      await append(`outcome-${sha256(operation.operation)}`, { schemaVersion: 1, kind: "audit-production-outcome", intentSha256: sha256(canonicalJson(intent)), producer, state: "positively-reconciled" });
      outcomes.add(operation.operation);
    },
  });
}
