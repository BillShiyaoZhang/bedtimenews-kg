const workflowId = "pages.yml";
const workflowPath = ".github/workflows/pages.yml";
const activeStatuses = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);
const completedConclusions = new Set([
  "success", "failure", "cancelled", "timed_out", "action_required", "neutral",
  "skipped", "stale", "startup_failure",
]);

// Called only after validation/build and a successful push (or a clean no-op).
// Never use the sync run's head_sha: a rerun can check out a newer main.
export async function reconcilePagesDeployment({ github, core, repo, targetSha }) {
  if (!/^[a-f0-9]{40}$/u.test(targetSha ?? "")) {
    throw new Error("Pages reconciliation requires the validated checkout's full commit SHA.");
  }
  const parameters = { ...repo, workflow_id: workflowId };
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...parameters,
    branch: "main",
    head_sha: targetSha,
    per_page: 100,
  });
  const matching = runs.filter((run) => matchesTarget(run, targetSha));
  for (const run of matching) {
    if (!(activeStatuses.has(run.status) ||
        (run.status === "completed" && completedConclusions.has(run.conclusion)))) {
      throw new Error(`Unrecognized Pages run state for run ${run.id}; refusing to guess or dispatch.`);
    }
  }
  // A later failed rerun must not hide a deployment that an earlier attempt
  // already completed. Check the actual deployment job across all attempts.
  for (const run of matching.filter((run) => run.status === "completed")) {
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...repo, run_id: run.id, filter: "all", per_page: 100,
    });
    if (jobs.some((job) => job.name === "deploy" && job.conclusion === "success" &&
        job.steps?.some((step) => step.name === "Deploy to GitHub Pages" && step.conclusion === "success"))) {
      return report(core, targetSha, "already deployed", run);
    }
  }
  const active = matching.find((run) => activeStatuses.has(run.status));
  if (active) {
    return report(core, targetSha, "already queued or running; deployment not yet confirmed", active);
  }
  // GitHub caps filtered workflow-run searches at 1,000 results.
  if (runs.length >= 1_000) {
    throw new Error("Pages run history reached the API search limit; refusing to dispatch with incomplete evidence.");
  }

  // Avoid dispatching an obsolete checkout if another writer advanced main.
  // The Pages input guard also closes the race between this read and dispatch.
  const { data: ref } = await github.rest.git.getRef({ ...repo, ref: "heads/main" });
  if (ref.object?.sha !== targetSha) {
    throw new Error("main no longer matches the validated checkout; run archive sync again before dispatching Pages.");
  }

  // Explicit dispatch is necessary for commits pushed by GITHUB_TOKEN.
  // Do not retry this mutation here: a transport error may occur after acceptance.
  const { data: dispatched } = await github.rest.actions.createWorkflowDispatch({
    ...parameters,
    ref: "main",
    inputs: { expected_sha: targetSha },
    return_run_details: true,
  });
  if (!Number.isSafeInteger(dispatched?.workflow_run_id) || dispatched.workflow_run_id <= 0) {
    throw new Error("Pages dispatch returned no run ID; acceptance is uncertain. Inspect Pages runs before retrying sync.");
  }
  const { data: run } = await github.rest.actions.getWorkflowRun({
    ...repo, run_id: dispatched.workflow_run_id,
  });
  if (!matchesTarget(run, targetSha)) {
    throw new Error(`Pages run ${dispatched.workflow_run_id} does not match the validated commit; deployment is not confirmed. Run archive sync again for current main.`);
  }
  if (run.status === "completed" && run.conclusion !== "success") {
    throw new Error(`Pages run ${run.id} already ended with ${run.conclusion}; deployment failed.`);
  }
  return report(core, targetSha, "dispatched; deployment not yet confirmed", run);
}

function matchesTarget(run, targetSha) {
  return run?.head_sha === targetSha && run.head_branch === "main" &&
    run.path?.split("@")[0] === workflowPath &&
    ["push", "workflow_dispatch"].includes(run.event);
}

async function report(core, targetSha, state, run) {
  const message = `Pages ${state}: commit ${targetSha}, run ${run.id}.`;
  core.info(message);
  await core.summary.addRaw(`${message}\n`).write();
  return { state, targetSha, runId: run.id };
}
