import assert from "node:assert/strict";
import test from "node:test";
import { createActionsReleaseMutationGuard, describeActionsHistoryFailure, reconcileReleasePages, summarizeValidationFailure, createReleaseGitHubClient } from "../scripts/lib/release-runtime.mjs";

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

const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const historyPath = `/repos/${repository}/actions/workflows/sync-archive.yml/runs?branch=main&per_page=100&page=1`;

test("history GET recovers a timeout and 503 without skipping failed attempts or retrying writes", async () => {
  const calls = [], delays = []; let jobReads = 0;
  const { request } = createReleaseGitHubClient({ repository, token: "private-fixture-token", sleep: async (ms) => delays.push(ms), fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.includes("/workflows/")) return response({ workflow_runs: [current, previous] });
    if (url.includes("/runs/20/")) return response({ jobs: [job(null)] });
    jobReads++;
    if (jobReads === 1) throw new DOMException("private transport message", "TimeoutError");
    if (jobReads === 2) return response({ message: "private server body" }, 503);
    return response({ jobs: [job("failure")] });
  } });
  const guard = await createActionsReleaseMutationGuard({ repository, request, runId: 20, runAttempt: 1 });
  assert.deepEqual(guard.blockedAttempts, ["10:1"]);
  assert.throws(guard.assertMutationAllowed, /read-only reconciliation/u);
  assert.equal(jobReads, 3); assert.deepEqual(delays, [250, 1000]);
  assert.ok(calls.every((call) => call.method === "GET"));
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} history exhaustion stays closed with bounded redacted diagnostics`, async () => {
    let calls = 0; const delays = [];
    const { request } = createReleaseGitHubClient({ repository, token: "private-fixture-token", sleep: async (ms) => delays.push(ms), fetchImpl: async () => {
      calls++; return response({ message: "secret-response-body" }, status);
    } });
    await assert.rejects(createActionsReleaseMutationGuard({ repository, request, runId: 20, runAttempt: 1 }), (error) => {
      assert.deepEqual(describeActionsHistoryFailure(error), { phase: "runs", page: 1, kind: "http-failure", method: "GET", attempts: 4, status });
      assert.doesNotMatch(JSON.stringify(describeActionsHistoryFailure(error)), /private-fixture|secret-response/u);
      return true;
    });
    assert.equal(calls, 4); assert.deepEqual(delays, [250, 1000, 2000]);
  });
}

for (const status of [401, 403, 404, 422]) {
  test(`HTTP ${status} is not retried or mistaken for an empty history`, async () => {
    let calls = 0;
    const { request } = createReleaseGitHubClient({ repository, token: "fixture-token", sleep: async () => assert.fail("unexpected retry"), fetchImpl: async () => {
      calls++; return response({}, status);
    } });
    await assert.rejects(request(historyPath), new RegExp(`HTTP ${status}`, "u"));
    assert.equal(calls, 1);
  });
}

test("Retry-After outside the fixed budget never triggers an early retry", async () => {
  for (const retryAfter of ["60", "Thu, 01 Oct 2026 14:00:00 GMT", "invalid"]) {
    let calls = 0;
    const { request } = createReleaseGitHubClient({ repository, token: "fixture-token", sleep: async () => assert.fail("unexpected retry"), fetchImpl: async () => {
      calls++; return response({}, 429, { "retry-after": retryAfter });
    } });
    await assert.rejects(request(historyPath), /HTTP 429/u); assert.equal(calls, 1);
  }
});

test("POST errors, lost responses and unreadable success bodies are never retried", async () => {
  for (const fail of [
    () => response({ message: "private" }, 503),
    () => { throw new TypeError("credential-in-error"); },
    () => ({ ok: true, status: 200, json: async () => { throw new TypeError("lost response"); } }),
  ]) {
    let calls = 0;
    const { request } = createReleaseGitHubClient({ repository, token: "fixture-token", sleep: async () => assert.fail("unexpected retry"), fetchImpl: async () => { calls++; return fail(); } });
    await assert.rejects(request(`/repos/${repository}/actions/workflows/pages.yml/dispatches`, { method: "POST", body: { ref: "main" } }), (error) => {
      assert.doesNotMatch(error.message, /credential-in-error|private|lost response/u); return true;
    });
    assert.equal(calls, 1);
  }
});

test("invalid JSON fails once while interrupted GET response bodies can retry", async () => {
  let calls = 0;
  const invalid = createReleaseGitHubClient({ repository, token: "fixture-token", fetchImpl: async () => { calls++; return new Response("secret-invalid-json"); } });
  await assert.rejects(invalid.request(historyPath), /invalid-json/u); assert.equal(calls, 1);
  calls = 0;
  const interrupted = createReleaseGitHubClient({ repository, token: "fixture-token", sleep: async () => {}, fetchImpl: async () => {
    calls++;
    return calls === 1 ? { ok: true, status: 200, json: async () => { throw new TypeError("private body error"); } } : response({ workflow_runs: [] });
  } });
  assert.deepEqual(await interrupted.request(historyPath), { workflow_runs: [] }); assert.equal(calls, 2);
});

test("history diagnostics identify the job/page and hide arbitrary request errors", async () => {
  const request = async (path) => {
    if (path.includes("/workflows/")) return { workflow_runs: [current, previous] };
    if (path.includes("/runs/20/")) return { jobs: [] };
    throw new Error("https://private.example/?token=secret");
  };
  await assert.rejects(createActionsReleaseMutationGuard({ repository, request, runId: 20, runAttempt: 1 }), (error) => {
    assert.deepEqual(describeActionsHistoryFailure(error), { phase: "jobs", runId: 10, page: 1, kind: "request-failed" }); return true;
  });
  assert.deepEqual(describeActionsHistoryFailure(new Error("secret")), { phase: "history", kind: "unexpected-error" });
});

test("null or malformed history remains blocked with a distinct validation reason", async () => {
  for (const result of [null, {}, { workflow_runs: null }]) {
    await assert.rejects(createActionsReleaseMutationGuard({ repository, request: async () => result, runId: 20, runAttempt: 1 }), (error) => {
      assert.deepEqual(describeActionsHistoryFailure(error), { phase: "runs", page: 1, kind: "invalid-history", reason: "Actions history is unavailable" }); return true;
    });
  }
});
