const must = (value) => { if (!value) throw new Error("Read-only build recovery rejected"); };

// A failed reconstruction is not an upload allocation. Explicitly verify the
// original attempt; never rerun it, erase its evidence, or reset a fence.
export async function verifyFailedBuildRecovery({ api, failure, scope }) {
  const run = await api(`/actions/runs/${failure.runId}`);
  must(run.id === failure.runId && run.head_sha === failure.headSha && run.run_attempt === 1
    && run.event === "workflow_dispatch" && run.status === "completed" && run.conclusion === "failure"
    && run.path === ".github/workflows/sync-archive.yml" && run.head_branch === "fix/actions-audit-successor-20261009");
  const jobs = await api(`/actions/runs/${failure.runId}/attempts/1/jobs?per_page=100`);
  must(jobs.total_count === jobs.jobs.length && jobs.jobs.length === 5);
  const reconstruct = jobs.jobs.find((job) => job.name === "reconstruct");
  must(reconstruct?.id === failure.reconstructJobId && reconstruct.status === "completed" && reconstruct.conclusion === "failure");
  for (const name of ["upload", "sync", "release-sync", "notify-sync-failure"]) {
    const job = jobs.jobs.find((item) => item.name === name);
    must(job?.status === "completed" && job.conclusion === "skipped" && job.steps.length === 0);
  }
  const refs = await api(`/git/matching-refs/tags/kg-upload-authority-${scope.bundleId}`);
  must(Array.isArray(refs) && refs.length === 0);
  const assets = await api(`/releases/${scope.releaseId}/assets?per_page=100`);
  must(Array.isArray(assets) && assets.length === 0);
  return { kind: "failed-read-only-build-reconciled", runId: failure.runId, headSha: failure.headSha, uploadSkipped: true, successorOrdinal: 1 };
}
