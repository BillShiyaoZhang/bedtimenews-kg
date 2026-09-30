import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { reconcilePagesDeployment } from "../scripts/reconcile-pages-deployment.mjs";

const targetSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const repo = { owner: "example", repo: "repository" };
const bash = process.platform === "win32"
  ? [
      join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Programs/Git/bin/bash.exe"),
    ].find((path) => existsSync(path)) ?? "bash"
  : "bash";
const sync = await readFile(new URL("../.github/workflows/sync-archive.yml", import.meta.url), "utf8");
const pages = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");

test("sync reconciles Pages after both push and no-op, without bypassing validation", () => {
  const step = sync.split("      - name: Deploy updated GitHub Pages\n")[1].split("\n  # A separate job")[0];
  assert.doesNotMatch(step, /\bif:|continue-on-error/u);
  assert.match(step, /TARGET_SHA: \$\{\{ steps\.commit\.outputs\.target_sha \}\}/u);
  assert.match(step, /reconcile-pages-deployment\.mjs/u);
  assert.match(step, /targetSha: process\.env\.TARGET_SHA/u);
  assert.match(sync, /group: kg-main-writer\n  cancel-in-progress: false/u);
  const sequence = ["npm run kg:validate", "npm run test:required", "npm run build:pages", "Commit and push validated archive sync", "Deploy updated GitHub Pages"];
  assert.deepEqual(sequence.map((value) => sync.indexOf(value)), sequence.map((value) => sync.indexOf(value)).sort((a, b) => a - b));
});

for (const changed of [false, true]) {
  test(`commit step exports actual HEAD when changed=${changed}`, async (context) => {
    const result = await runCommitStep(context, { changed });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, `changed=${changed}\ntarget_sha=${targetSha}\n`);
    assert.equal(result.stdout.includes("git push origin HEAD:main"), changed);
    assert.equal(result.stdout.includes("git commit -m data: sync Bedtime News archive"), changed);
  });
}

test("failed push does not export a deployable target", async (context) => {
  const result = await runCommitStep(context, { changed: true, failPush: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.output, "");
});

test("missing dispatch after a committed sync recovers, then a no-op reuses the run", async () => {
  const fixture = createFixture();
  const first = await fixture.run();
  assert.equal(first.runId, 42);
  assert.match(first.state, /^dispatched/u);
  const second = await fixture.run();
  assert.match(second.state, /^already queued/u);
  assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 1);
  assert.deepEqual(fixture.calls.find((call) => call.method === "dispatch").params, {
    ...repo, workflow_id: "pages.yml", ref: "main", inputs: { expected_sha: targetSha }, return_run_details: true,
  });
  assert.deepEqual(fixture.calls[0].params, {
    ...repo, workflow_id: "pages.yml", branch: "main", head_sha: targetSha, per_page: 100,
  });
});

test("a successful deploy job and deployment step suppress duplicate deployment", async () => {
  const fixture = createFixture([run({ status: "completed", conclusion: "success" })]);
  const result = await fixture.run();
  assert.equal(result.state, "already deployed");
  assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 0);
  assert.deepEqual(fixture.calls.find((call) => call.method === "jobs").params, {
    ...repo, run_id: 1, filter: "all", per_page: 100,
  });
  assert.match(fixture.summaries[0], new RegExp(targetSha, "u"));
});

test("a failed rerun does not hide an earlier successful deployment of the same SHA", async () => {
  const fixture = createFixture([run({ status: "completed", conclusion: "failure", run_attempt: 2 })]);
  fixture.jobs = [
    { name: "deploy", conclusion: "failure", run_attempt: 2 },
    { name: "deploy", conclusion: "success", run_attempt: 1, steps: [{ name: "Deploy to GitHub Pages", conclusion: "success" }] },
  ];
  assert.equal((await fixture.run()).state, "already deployed");
  assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 0);
  assert.equal(fixture.calls.find((call) => call.method === "jobs").params.filter, "all");
});

for (const status of ["queued", "in_progress", "requested", "waiting", "pending"]) {
  test(`an existing ${status} deployment suppresses dispatch without claiming success`, async () => {
    const fixture = createFixture([run({ status })]);
    assert.match((await fixture.run()).state, /deployment not yet confirmed/u);
    assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 0);
  });
}

for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"]) {
  test(`a ${conclusion} deployment is retried for the validated commit`, async () => {
    const fixture = createFixture([run({ status: "completed", conclusion })]);
    assert.match((await fixture.run()).state, /^dispatched/u);
    assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 1);
  });
}

for (const jobs of [[], [{ name: "deploy", conclusion: "skipped" }], [{ name: "deploy", conclusion: "success", steps: [{ name: "Deploy to GitHub Pages", conclusion: "skipped" }] }]]) {
  test(`workflow success alone is insufficient: ${JSON.stringify(jobs)}`, async () => {
    const fixture = createFixture([run({ status: "completed", conclusion: "success" })]);
    fixture.jobs = jobs;
    assert.match((await fixture.run()).state, /^dispatched/u);
  });
}

test("successful runs are searched across the paginated result, not only the newest failure", async () => {
  const fixture = createFixture([
    ...Array.from({ length: 100 }, (_, index) => run({ id: index + 2, status: "completed", conclusion: "failure" })),
    run({ status: "completed", conclusion: "success" }),
  ]);
  assert.equal((await fixture.run()).state, "already deployed");
  assert.deepEqual(fixture.paginatedMethods, ["runs", ...Array(101).fill("jobs")]);
});

test("the GitHub search cap is not mistaken for complete evidence that no deploy succeeded", async () => {
  const fixture = createFixture(Array.from({ length: 1_000 }, (_, index) =>
    run({ id: index + 1, status: "completed", conclusion: "failure" })));
  await assert.rejects(fixture.run, /API search limit/u);
  assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 0);
});

for (const mismatch of [{ head_sha: otherSha }, { head_branch: "topic" }, { path: ".github/workflows/validate.yml" }, { event: "pull_request" }]) {
  test(`an unrelated success cannot satisfy the target: ${JSON.stringify(mismatch)}`, async () => {
    const fixture = createFixture([run({ status: "completed", conclusion: "success", ...mismatch })]);
    assert.match((await fixture.run()).state, /^dispatched/u);
  });
}

test("a newer main is never replaced with an older target deployment", async () => {
  const fixture = createFixture([run({ head_sha: otherSha, status: "completed", conclusion: "success" })]);
  fixture.refSha = otherSha;
  await assert.rejects(fixture.run, /main no longer matches/u);
  assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 0);
  assert.equal(fixture.summaries.length, 0);
});

test("a race between branch lookup and dispatch is reported rather than accepted as the target", async () => {
  const fixture = createFixture();
  fixture.dispatchedRun = run({ id: 42, head_sha: otherSha });
  await assert.rejects(fixture.run, /does not match the validated commit/u);
  assert.equal(fixture.summaries.length, 0);
});

for (const method of ["runs", "ref", "dispatch", "getRun", "jobs"]) {
  test(`${method} API failures are visible and never automatically retry dispatch`, async () => {
    const fixture = createFixture(method === "jobs" ? [run({ status: "completed", conclusion: "success" })] : []);
    fixture.failures.add(method);
    await assert.rejects(fixture.run, /API unavailable/u);
    assert.ok(fixture.calls.filter((call) => call.method === "dispatch").length <= 1);
    assert.equal(fixture.summaries.length, 0);
  });
}

test("uncertain dispatch acceptance fails visibly; a later no-op can find its accepted run", async () => {
  const fixture = createFixture();
  fixture.dispatchResponse = undefined;
  await assert.rejects(fixture.run, /acceptance is uncertain/u);
  assert.match((await fixture.run()).state, /^already queued/u);
  assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 1);
});

test("a timeout after server acceptance is reconciled without blindly redispatching", async () => {
  const fixture = createFixture();
  fixture.dispatchErrorAfterAcceptance = true;
  await assert.rejects(fixture.run, /timeout after acceptance/u);
  assert.match((await fixture.run()).state, /^already queued/u);
  assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 1);
});

test("an immediately failed dispatched run is reported as a failure", async () => {
  const fixture = createFixture();
  fixture.dispatchedRun = run({ id: 42, status: "completed", conclusion: "failure" });
  await assert.rejects(fixture.run, /deployment failed/u);
  assert.equal(fixture.summaries.length, 0);
});

test("unknown run states and invalid targets fail closed", async () => {
  const fixture = createFixture([run({ status: "unknown" })]);
  await assert.rejects(fixture.run, /Unrecognized Pages run state/u);
  await assert.rejects(() => fixture.run("main"), /full commit SHA/u);
  assert.equal(fixture.calls.filter((call) => call.method === "dispatch").length, 0);
});

test("Pages checks the expected event SHA before checkout without changing checkout ref", () => {
  const script = extractScript(pages, "Verify requested deployment commit", "run");
  for (const expected of ["", targetSha, otherSha]) {
    const result = spawnSync(bash, ["-e", "-c", script], {
      encoding: "utf8", env: { ...process.env, EXPECTED_SHA: expected, GITHUB_SHA: targetSha },
    });
    assert.equal(result.status, expected === otherSha ? 1 : 0, result.stderr);
  }
  assert.ok(pages.indexOf("Verify requested deployment commit") < pages.indexOf("- name: Checkout"));
  assert.match(pages, /group: \$\{\{ inputs\.expected_sha && inputs\.expected_sha != github\.sha && format\('pages-stale-\{0\}', github\.run_id\) \|\| 'pages' \}\}/u);
  assert.match(pages, /cancel-in-progress: false/u);
  assert.doesNotMatch(pages, /cancel-in-progress: true/u);
  assert.doesNotMatch(pages, /ref: \$\{\{ inputs\.expected_sha/u);
});

test("Pages refuses a superseded or non-main run immediately before deployment", async () => {
  const script = extractScript(pages, "Refuse superseded deployment", "script");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("github", "context", script);
  const github = { rest: { git: { getRef: async () => ({ data: { object: { sha: targetSha } } }) } } };
  await execute(github, { repo, sha: targetSha, ref: "refs/heads/main" });
  await assert.rejects(() => execute(github, { repo, sha: otherSha, ref: "refs/heads/main" }), /refusing to deploy/u);
  await assert.rejects(() => execute(github, { repo, sha: targetSha, ref: "refs/heads/topic" }), /refusing to deploy/u);
  github.rest.git.getRef = async () => { throw new Error("API unavailable"); };
  await assert.rejects(() => execute(github, { repo, sha: targetSha, ref: "refs/heads/main" }), /API unavailable/u);
  assert.ok(pages.indexOf("Refuse superseded deployment") < pages.indexOf("- name: Deploy to GitHub Pages"));
});

function run(overrides = {}) {
  return { id: 1, head_sha: targetSha, head_branch: "main", path: ".github/workflows/pages.yml", event: "workflow_dispatch", status: "queued", conclusion: null, ...overrides };
}

function createFixture(runs = []) {
  const fixture = {
    calls: [], failures: new Set(), summaries: [], paginatedMethods: [], runs,
    refSha: targetSha, dispatchedRun: run({ id: 42 }), dispatchResponse: { workflow_run_id: 42 },
  };
  const method = (name, implementation) => Object.assign(async (params) => {
    fixture.calls.push({ method: name, params });
    if (fixture.failures.has(name)) throw new Error("API unavailable");
    return { data: implementation(params) };
  }, { methodName: name });
  const github = {
    rest: {
      actions: {
        listWorkflowRuns: method("runs", () => ({ workflow_runs: fixture.runs })),
        listJobsForWorkflowRun: method("jobs", ({ run_id }) => ({ jobs: fixture.jobs ??
          (fixture.runs.find((item) => item.id === run_id)?.conclusion === "success"
            ? [{ name: "deploy", conclusion: "success", steps: [{ name: "Deploy to GitHub Pages", conclusion: "success" }] }]
            : []) })),
        createWorkflowDispatch: method("dispatch", () => {
          fixture.runs.push(fixture.dispatchedRun);
          if (fixture.dispatchErrorAfterAcceptance) throw new Error("timeout after acceptance");
          return fixture.dispatchResponse;
        }),
        getWorkflowRun: method("getRun", ({ run_id }) => fixture.runs.find((item) => item.id === run_id)),
      },
      git: { getRef: method("ref", () => ({ object: { sha: fixture.refSha } })) },
    },
    async paginate(apiMethod, params) {
      fixture.paginatedMethods.push(apiMethod.methodName);
      const { data } = await apiMethod(params);
      return data.workflow_runs ?? data.jobs;
    },
  };
  const core = { info() {}, summary: { addRaw(value) { fixture.summaries.push(value); return this; }, async write() {} } };
  fixture.run = (sha = targetSha) => reconcilePagesDeployment({ github, core, repo, targetSha: sha });
  return fixture;
}

function extractScript(workflow, step, kind) {
  const indent = kind === "run" ? 8 : 10;
  return workflow.split(`      - name: ${step}\n`)[1]
    .split(`${" ".repeat(indent)}${kind}: |\n`)[1]
    .split(new RegExp(`\\n(?= {0,${indent}}\\S)`, "u"))[0]
    .split("\n").map((line) => line.slice(indent + 2)).join("\n");
}

async function runCommitStep(context, { changed, failPush = false }) {
  const directory = await mkdtemp(join(tmpdir(), "pages-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  const script = extractScript(sync, "Commit and push validated archive sync", "run");
  const result = spawnSync(bash, ["-e", "-c", `
    git() {
      if [[ "$1" == rev-parse ]]; then printf '%s\\n' "$ACTUAL_HEAD"; return; fi
      printf 'git %s\\n' "$*"
      if [[ "$1" == diff ]]; then [[ "$HAS_CHANGES" == false ]]; return; fi
      if [[ "$1" == push && "$FAIL_PUSH" == true ]]; then return 1; fi
    }
    ${script}
  `], {
    encoding: "utf8",
    env: {
      ...process.env, GITHUB_OUTPUT: output.replaceAll("\\", "/"), GITHUB_SHA: otherSha,
      ACTUAL_HEAD: targetSha, HAS_CHANGES: String(changed), FAIL_PUSH: String(failPush),
    },
  });
  return { ...result, output: await readFile(output, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  }) };
}
