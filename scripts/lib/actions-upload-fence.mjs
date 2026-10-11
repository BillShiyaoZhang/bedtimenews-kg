import { canonicalJson, sha256 } from "./candidate-bundle.mjs";

const must = (v) => { if (!v) throw new Error("Actions audit fence rejected"); };
export function successorFenceKey(scope, assetName, ordinal = 1) {
  must(ordinal === 1 && scope.successorOrdinal === 1);
  return sha256(`${scope.repository}\n${scope.releaseId}\n${assetName}\n${ordinal}`);
}

// Create-only refs retain immutable Git record objects across runner loss. They
// are append-only by protocol, not an administrator-proof WORM facility.
export function createActionsUploadFence({ api, scope, run, authoritySha256 }) {
  const prefix = `tags/kg-upload-authority-${scope.bundleId}`;
  async function createRecord(ref, value, { allowExisting = false } = {}) {
    const content = `${canonicalJson(value)}\n`;
    if (allowExisting) {
      const prior = await api(`/git/ref/${ref}`, { missing: true });
      if (prior) {
        const commit = await api(`/git/commits/${prior.object.sha}`);
        const tree = await api(`/git/trees/${commit.tree.sha}`);
        must(tree.tree.length === 1 && tree.tree[0].path === "record.json" && tree.tree[0].mode === "100644");
        const blob = await api(`/git/blobs/${tree.tree[0].sha}`);
        must(blob.encoding === "base64" && Buffer.from(blob.content, "base64").toString("utf8") === content);
        return prior.object.sha;
      }
    }
    const blob = await api("/git/blobs", { method: "POST", body: { encoding: "utf-8", content } });
    const tree = await api("/git/trees", { method: "POST", body: { tree: [{ path: "record.json", mode: "100644", type: "blob", sha: blob.sha }] } });
    const commit = await api("/git/commits", { method: "POST", body: { message: "Retain reviewed audit upload evidence", tree: tree.sha, parents: [] } });
    // A lost create response MUST stop. Reading a matching ref later never
    // grants the right to execute an upload, even to the same run/attempt.
    await api("/git/refs", { method: "POST", status: 201, body: { ref: `refs/${ref}`, sha: commit.sha } });
    const actual = await api(`/git/ref/${ref}`);
    must(actual.ref === `refs/${ref}` && actual.object.type === "commit" && actual.object.sha === commit.sha);
    return commit.sha;
  }
  return {
    retainEvidence: (evidence) => createRecord(`${prefix}-evidence-${sha256(canonicalJson(evidence))}`, evidence, { allowExisting: true }),
    async reserve(assetName) {
      const key = successorFenceKey(scope, assetName);
      const ref = `${prefix}-intent-${key}`;
      const value = { schemaVersion: 1, kind: "actions-successor-intent", authoritySha256, run, releaseId: scope.releaseId, assetName, successorOrdinal: 1 };
      const intentCommit = await createRecord(ref, value);
      return { recordOutcome: (outcome) => createRecord(`${prefix}-outcome-${key}`, { schemaVersion: 1, intentCommit, authoritySha256, run, outcome }) };
    },
  };
}
