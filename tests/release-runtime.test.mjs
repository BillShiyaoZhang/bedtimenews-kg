import assert from "node:assert/strict";
import test from "node:test";
import { createActionsReleaseMutationGuard, reconcileReleasePages, summarizeValidationFailure, createReleaseGitHubClient } from "../scripts/lib/release-runtime.mjs";

const stepName = "Fully materialize, validate, accept and recover publication";
const repository = "fixture/accepted-sync";
const previous = { id: 10, event: "schedule" };
const current = { id: 20, event: "schedule" };
function fixture(jobs = {}, runs = [current, previous]) {
  const methods = [];
  return { methods, request: async (path, options = {}) => {
    methods.push(options.method ?? "GET");
    if (path.includes("/workflows/")) return { workflow_runs: runs };
    const id = Number(/\/runs\/(\d+)\/jobs/u.exec(path)?.[1]);
    return { jobs: jobs[id] ?? [] };
  } };
}
const job = (conclusion, run_attempt = 1, extra = []) => ({ name: "release-sync", run_attempt, steps: [{ name: stepName, status: "completed", conclusion }, ...extra] });

test("first Actions attempt and legacy-only history allow mutations", async () => {
  const f = fixture({ 20: [job(null)] });
  const guard = await createActionsReleaseMutationGuard({ ...f, repository, runId: 20, runAttempt: 1 });
  assert.deepEqual(guard.blockedAttempts, []); assert.doesNotThrow(guard.assertMutationAllowed);
  assert.ok(f.methods.every((method) => method === "GET"));
});

for (const conclusion of ["failure", "cancelled", "timed_out", null]) {
  test(`earlier ${conclusion} release attempt permits only read-only reconciliation`, async () => {
    const f = fixture({ 10: [job(conclusion)] });
    const guard = await createActionsReleaseMutationGuard({ ...f, repository, runId: 20, runAttempt: 1 });
    assert.deepEqual(guard.blockedAttempts, ["10:1"]); assert.throws(guard.assertMutationAllowed, /read-only reconciliation/u);
    assert.ok(f.methods.every((method) => method === "GET"));
  });
}

test("failed earlier attempt of the same rerun is not hidden", async () => {
  const f = fixture({ 20: [job("failure"), job(null, 2)] });
  const guard = await createActionsReleaseMutationGuard({ ...f, repository, runId: 20, runAttempt: 2 });
  assert.deepEqual(guard.blockedAttempts, ["20:1"]);
});

test("operator resolution is exact, observed, and reusable only from a successful manual run", async () => {
  const f = fixture({ 10: [job("failure")] });
  const guard = await createActionsReleaseMutationGuard({ ...f, repository, runId: 20, runAttempt: 1, resolvedAttempts: "10:1" });
  assert.doesNotThrow(guard.assertMutationAllowed);
  await assert.rejects(createActionsReleaseMutationGuard({ ...f, repository, runId: 20, runAttempt: 1, resolvedAttempts: "9:1" }), /not found/u);
  const recorded = fixture({ 10: [job("failure")], 15: [job("success", 1, [{ name: "Operator-reviewed release attempts: 10:1", conclusion: "success" }])] }, [current, { id: 15, event: "workflow_dispatch" }, previous]);
  assert.doesNotThrow((await createActionsReleaseMutationGuard({ ...recorded, repository, runId: 20, runAttempt: 1 })).assertMutationAllowed);
});

test("missing current run or unreadable attempt history fails closed", async () => {
  await assert.rejects(createActionsReleaseMutationGuard({ ...fixture({}, []), repository, runId: 20, runAttempt: 1 }), /missing/u);
  await assert.rejects(createActionsReleaseMutationGuard({ ...fixture({ 10: [{ name: "release-sync", steps: [] }] }), repository, runId: 20, runAttempt: 1 }), /identity/u);
});

test("Pages intent is persisted before dispatch and an uncertain absence cannot redispatch", async () => {
  let state = { schemaVersion: 1, repository, pendingOperations: [], pages: null }; let dispatches = 0;
  const target = "a".repeat(40);
  const journal = { read: async () => structuredClone(state), write: async (value) => { state = structuredClone(value); } };
  const github = { paginate: async () => [], rest: { git: { getRef: async () => ({ data: { object: { sha: target } } }) }, actions: {
    listWorkflowRuns() {}, listJobsForWorkflowRun() {}, async createWorkflowDispatch() { assert.equal(state.pages.status, "intent"); dispatches++; throw new Error("response lost"); },
  } } };
  const core = { info() {}, summary: { addRaw() { return this; }, async write() {} } };
  const run = () => reconcileReleasePages({ github, core, repo: { owner: "fixture", repo: "accepted-sync" }, journal, commit: target });
  await assert.rejects(run(), /response lost/u); await assert.rejects(run(), /previous Pages dispatch is unresolved/u);
  assert.equal(dispatches, 1);
});


test("prepared failure diagnostics include a failed middle subtest before a long successful tail", () => {
  const output = ["ok 1 - first", "# Subtest: important failed gate", "not ok 2 - important failed gate", "  error: exact failure", ...Array.from({ length: 2000 }, (_, index) => `ok ${index + 3} - later passing test`)].join("\n");
  const summary = summarizeValidationFailure(output);
  assert.match(summary, /not ok 2 - important failed gate/u); assert.match(summary, /exact failure/u);
  assert.ok(summary.length <= 18000); assert.match(summary, /later passing test/u);
});


test("2026 workflow dispatch sends only ref/inputs and reads the returned run identity", async () => {
  const calls = [];
  const { github } = createReleaseGitHubClient({ repository, token: "fixture-token", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ workflow_run_id: 42, run_url: "https://api.github.com/repos/fixture/accepted-sync/actions/runs/42", html_url: "https://github.com/fixture/accepted-sync/actions/runs/42" }), { status: 200 });
  } });
  const { data } = await github.rest.actions.createWorkflowDispatch({ owner: "fixture", repo: "accepted-sync", workflow_id: "pages.yml", ref: "main", inputs: { expected_sha: "a".repeat(40) }, return_run_details: true });
  assert.equal(data.workflow_run_id, 42); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["X-GitHub-Api-Version"], "2026-03-10");
  assert.deepEqual(JSON.parse(calls[0].options.body), { ref: "main", inputs: { expected_sha: "a".repeat(40) } });
});
