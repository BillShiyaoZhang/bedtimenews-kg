import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson } from "./candidate-bundle.mjs";
import { discoverSnapshotArtifacts, readSnapshotMetadata, SNAPSHOT_FILES, snapshotProducer, validateSnapshotDirectory } from "./audit-snapshot.mjs";
import { createOfflineCheckpointStore } from "./offline-checkpoint-store.mjs";

const execFile = promisify(callback);
const must = (value) => { if (!value) throw new Error("Audit snapshot download rejected"); };

export async function readApprovedProductionPlan(api, commit) {
  must(/^[a-f0-9]{40}$/u.test(commit));
  const record = await api(`/git/commits/${commit}`); must(record.sha === commit);
  must(/^[a-f0-9]{40}$/u.test(record.tree?.sha));
  const tree = await api(`/git/trees/${record.tree.sha}`);
  must(tree.sha === record.tree.sha && tree.truncated === false && Array.isArray(tree.tree));
  const matches = tree.tree.filter((entry) => entry.path === "audit-production-plan.json");
  must(matches.length === 1 && matches[0].mode === "100644" && matches[0].type === "blob"
    && /^[a-f0-9]{40}$/u.test(matches[0].sha) && matches[0].size <= 128 * 1024);
  const blob = await api(`/git/blobs/${matches[0].sha}`);
  must(blob.sha === matches[0].sha && blob.encoding === "base64" && blob.size <= 128 * 1024);
  const bytes = Buffer.from(blob.content, "base64");
  must(bytes.length === blob.size && createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === blob.sha);
  return bytes;
}

// Called only by code checked out at the authenticated PR base. All eligible
// snapshots are checked; conflicting authorities never select a newest winner.
export async function downloadAuditSnapshot({ client, policy, baseCommit, receipt, outputDirectory }) {
  const candidates = await discoverSnapshotArtifacts({ api: client.api, policy, baseCommit, receipt });
  const temporary = await mkdtemp(resolve(tmpdir(), "trusted-audit-snapshot-"));
  let selected, authority;
  try {
    for (const { artifact, run } of candidates) {
      const archive = resolve(temporary, `${artifact.id}.zip`), directory = resolve(temporary, `${artifact.id}`);
      await writeFile(archive, await client.download(artifact, policy.maximumArchiveBytes), { flag: "wx", mode: 0o600 });
      await execFile("python3", ["-I", resolve(import.meta.dirname, "../extract-audit-snapshot.py"), archive, directory], { maxBuffer: 1024 });
      const metadata = await readSnapshotMetadata(directory);
      const snapshot = await validateSnapshotDirectory({ directory, policy, baseCommit, receipt, producer: snapshotProducer(run),
        approvedPlanBytes: await readApprovedProductionPlan(client.api, metadata.planCommit) });
      const identity = canonicalJson({ planCommit: snapshot.planCommit, planSha256: snapshot.planSha256, plan: snapshot.plan, receipt: snapshot.receipt });
      if (authority !== undefined) must(identity === authority);
      else { authority = identity; selected = { artifactId: artifact.id, runId: run.id, directory, snapshot }; }
    }
    must(selected);
    await mkdir(outputDirectory); // Refuse reuse after partial/uncertain work.
    for (const name of SNAPSHOT_FILES) await writeFile(resolve(outputDirectory, name), await readFile(resolve(selected.directory, name)), { flag: "wx", mode: 0o600 });
    await createOfflineCheckpointStore({ directory: outputDirectory, receipt }).readBundle({ receipt });
    return { artifactId: selected.artifactId, runId: selected.runId, planCommit: selected.snapshot.planCommit, snapshotVerified: true, liveReleaseVerified: false };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
