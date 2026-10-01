import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson } from "./candidate-bundle.mjs";
import { createAuthenticatedGitReader } from "./git-object-integrity.mjs";
import { readVerifiedGitSources } from "./source-snapshot.mjs";
import { sourceInventory } from "./candidate-run.mjs";
import { RELEASE_SOURCE_PATH } from "./release-sync.mjs";

const execFile = promisify(execFileCallback);
const SHA = /^[a-f0-9]{40}$/u;
const must = (value, message) => { if (!value) throw new Error(`Release runtime: ${message}`); };
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", TZ: "UTC", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
async function git(root, args) {
  try { return (await execFile("git", ["--no-replace-objects", "-C", root, ...args], { env: env(), maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error(`Release runtime: Git ${args[0]} failed (credentials and remote errors redacted)`); }
}

export function createReleaseGitTransport(root, { repository, verifyOrigin } = {}) {
  must(typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository), "explicit transport repository required");
  must(verifyOrigin === undefined || typeof verifyOrigin === "function", "invalid fixture identity verifier");
  async function assertIdentity(target = repository, ref = "refs/heads/main") {
    must(target === repository && ref === "refs/heads/main", "transport repository/ref mismatch");
    const origin = await git(root, ["config", "--get", "remote.origin.url"]);
    // Production uses the fixed GitHub identity. An injected verifier exists
    // only for real temporary local-bare transport tests, never a CLI flag.
    const verified = verifyOrigin ? await verifyOrigin({ root, repository, origin })
      : [`https://github.com/${repository}`, `https://github.com/${repository}.git`, `git@github.com:${repository}.git`].includes(origin);
    must(verified === true, "transport origin differs from the approved repository");
  }
  return {
    async readMain({ repository: target = repository, ref = "refs/heads/main" } = {}) {
      await assertIdentity(target, ref);
      const result = await git(root, ["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
      must(/^[a-f0-9]{40}\trefs\/heads\/main$/u.test(result), "invalid remote main advertisement");
      return result.slice(0, 40);
    },
    async fetchMain() {
      await assertIdentity();
      await git(root, ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"]);
      const commit = await git(root, ["rev-parse", "refs/remotes/origin/main"]);
      must(SHA.test(commit), "invalid pinned main");
      return commit;
    },
    async pushFastForward({ repository: target, ref, expectedBase, commit, force }) {
      must(target === repository && ref === "refs/heads/main", "transport repository/ref mismatch");
      await assertIdentity(target, ref);
      must(force === false && SHA.test(expectedBase) && SHA.test(commit), "invalid non-forcing promotion");
      const reader = createAuthenticatedGitReader(async (oid) => {
        const { stdout } = await execFile("git", ["--no-replace-objects", "-C", root, "cat-file", "commit", oid], { env: env(), encoding: "buffer", maxBuffer: 1024 * 1024 });
        return { type: "commit", bytes: stdout };
      });
      const info = await reader.commit(commit);
      must(info.parents.length === 1 && info.parents[0] === expectedBase, "promotion must have exactly the expected parent");
      must(await this.readMain() === expectedBase, "remote main changed before push");
      // The explicit lease enforces receive-pack CAS. The authenticated sole
      // parent invariant makes every permitted write a fast-forward, including
      // if somebody rewinds main concurrently. Never use an unguarded fallback,
      // '+' refspec, --force, automatic rebase, or override existing push hooks.
      await git(root, ["push", "--porcelain", `--force-with-lease=refs/heads/main:${expectedBase}`, "origin", `${commit}:refs/heads/main`]);
    },
  };
}

export async function acquireReleaseSource(root, { checkpoint, bootstrap }) {
  must(await git(root, ["rev-parse", "HEAD"]) === checkpoint.commit, "checkout is not pinned main; start with a fresh main checkout");
  const dirty = await git(root, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"]);
  must(!dirty, "tracked checkout is dirty");
  const source = resolve(root, RELEASE_SOURCE_PATH);
  await git(root, ["submodule", "update", "--init", "--", RELEASE_SOURCE_PATH]);
  if (bootstrap) {
    // Never fetch or advance upstream while turning legacy acceptance into E.
    const state = JSON.parse(checkpoint.files.get("data/archive-state.json").toString("utf8"));
    must(equal(await sourceInventory(source, state.includedRoots), state.acceptedFiles), "bootstrap must use the exact legacy accepted source inventory; upstream acquisition is a later run");
  } else {
    must(!(await git(source, ["status", "--porcelain"])), "source checkout is dirty");
    await git(source, ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"]);
    const commit = await git(source, ["rev-parse", "refs/remotes/origin/main"]);
    must(SHA.test(commit), "invalid pinned upstream commit");
    await git(source, ["checkout", "--detach", commit]);
  }
  return source;
}

/** Validate the exact prepared tree in a disposable worktree. No accepted main
 * mutation and no accidental caller-index staging. Both rendering targets run. */
export async function validatePreparedRelease(root, { prepared, manifest, candidate }, { onProgress = () => {}, dependencyRoot = root } = {}) {
  const temporary = await mkdtemp(resolve(tmpdir(), "kg-release-validation-"));
  const worktree = resolve(temporary, "checkout");
  let added = false;
  try {
    await git(root, ["worktree", "add", "--detach", worktree, prepared.commit]); added = true;
    must((await readFile(resolve(worktree, "package-lock.json"))).equals(await readFile(resolve(dependencyRoot, "package-lock.json"))), "validation dependencies use a different lockfile");
    await cp(await realpath(resolve(dependencyRoot, "node_modules")), resolve(worktree, "node_modules"), { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    const freshSourceReplay = candidate.mode !== "rollback";
    if (freshSourceReplay) {
      const sourceBytes = await readVerifiedGitSources({ sourceRoot: resolve(root, RELEASE_SOURCE_PATH), commit: manifest.source.commit,
        inventory: candidate.artifacts["lifecycle.json.gz"].effectiveInventory });
      for (const [path, content] of sourceBytes) {
        const target = resolve(worktree, RELEASE_SOURCE_PATH, path);
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
      }
      sourceBytes.clear();
    } else onProgress("Accepted-output restoration: raw-source validation intentionally not claimed");
    // Strict fragment/topic checks use exact authenticated effective source
    // bytes. Full observed-source replay runs again after these builds.
    const validationEnv = { ...env() };
    for (const name of Object.keys(validationEnv)) if (name.startsWith("KG_RELEASE_") || /TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(name)) delete validationEnv[name];
    const failures = [];
    for (const script of ["ontology:check", "kg:release:validate", ...(freshSourceReplay ? ["kg:validate"] : []), "test:required", "lint", "build", "build:pages"]) {
      onProgress(`Validating prepared ${prepared.commit}: ${script}`);
      try { await execFile("npm", ["run", script], { cwd: worktree, env: validationEnv, maxBuffer: 64 * 1024 * 1024 }); }
      catch (error) { failures.push(script); onProgress(`Prepared validation failed: ${script}\n${summarizeValidationFailure(String(error.stdout ?? "") + "\n" + String(error.stderr ?? ""))}`); }
    }
    let coverage = "passed";
    try { await execFile("npm", ["run", "test:coverage"], { cwd: worktree, env: validationEnv, maxBuffer: 16 * 1024 * 1024 }); }
    catch { coverage = "advisory-failed"; onProgress("::warning title=Semantic coverage below threshold::Coverage remains advisory; required validation passed"); }
    const receipt = JSON.parse(await readFile(resolve(worktree, "data/accepted-release.json"), "utf8"));
    must(equal(receipt, manifest), "validation changed its accepted receipt");
    must(!(await git(worktree, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"])), "validation changed the prepared tree");
    must(failures.length === 0, `prepared checks failed: ${failures.join(", ")}`);
    return { coverage, required: "passed", rawSourceValidation: freshSourceReplay ? "passed" : "accepted-output-restore-only", builds: ["build", "build:pages"] };
  } finally {
    if (added) await git(root, ["worktree", "remove", "--force", worktree]);
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Include middle-of-stream failed subtests, not just a successful tail. */
export function summarizeValidationFailure(output) {
  let safe = String(output);
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(name) && value.length >= 8) safe = safe.split(value).join("[redacted]");
  }
  const lines = safe.split("\n"); const excerpts = [];
  for (let index = 0; index < lines.length && excerpts.length < 8; index++) {
    if (/^\s*(?:not ok\b|✖|failureType:|error:|AssertionError)/u.test(lines[index])) {
      excerpts.push(lines.slice(Math.max(0, index - 3), index + 28).join("\n").slice(0, 1800)); index += 27;
    }
  }
  return [...excerpts, "Last output:", safe.slice(-2500)].join("\n\n").slice(0, 18000);
}

const GITHUB_READ_DELAYS_MS = Object.freeze([0, 250, 1000, 2000]);
class ReleaseGitHubRequestError extends Error {
  constructor(kind, method, attempts, status = null) {
    super(`Release runtime: GitHub ${method} ${kind}${status === null ? "" : ` HTTP ${status}`} after ${attempts} attempt(s)`);
    this.details = { kind, method, attempts, status };
  }
}
class ActionsHistoryError extends Error {
  constructor(phase, context, reason) {
    super(`Release runtime: Actions history could not establish restart safety${reason.reason ? `: ${reason.reason}` : ""}`);
    this.details = { phase, ...context, ...reason };
  }
}

/** Only locally constructed categories are printable, never remote bodies,
 * transport error messages, URLs, tokens or arbitrary injected exceptions. */
export function describeActionsHistoryFailure(error) {
  return error instanceof ActionsHistoryError ? { ...error.details } : { phase: "history", kind: "unexpected-error" };
}

/** Minimal fixed-origin GitHub client for the CLI. Bounded retries apply only
 * to transient reads; mutation requests always have exactly one attempt. */
export function createReleaseGitHubClient({ repository, token, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  must(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) && typeof token === "string" && token.length > 0, "repository and token are required");
  const [owner, repo] = repository.split("/");
  async function request(path, { method = "GET", body, allow404 = false } = {}) {
    must(path.startsWith(`/repos/${repository}/`), "request outside approved repository");
    const attempts = ["GET", "HEAD"].includes(method) ? GITHUB_READ_DELAYS_MS.length : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(GITHUB_READ_DELAYS_MS[attempt - 1]);
      let response;
      try {
        response = await fetchImpl(`https://api.github.com${path}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch (error) {
        const transient = ["TypeError", "AbortError", "TimeoutError"].includes(error?.name);
        if (transient && attempt < attempts) continue;
        throw new ReleaseGitHubRequestError(transient ? "transport-failure" : "unexpected-transport-error", method, attempt);
      }
      if (allow404 && response.status === 404) return null;
      if (!response.ok) {
        const transient = [408, 429, 500, 502, 503, 504].includes(response.status);
        // Never retry sooner than a server's Retry-After. A delay beyond our
        // bounded budget (or an unrecognized value) fails closed instead.
        const retryAfter = response.headers.get("retry-after");
        const withinDelay = retryAfter === null || (/^\d+$/u.test(retryAfter) && Number(retryAfter) * 1000 <= (GITHUB_READ_DELAYS_MS[attempt] ?? 0));
        if (transient && withinDelay && attempt < attempts) {
          try { await response.body?.cancel(); } catch { /* Do not expose remote errors. */ }
          continue;
        }
        throw new ReleaseGitHubRequestError("http-failure", method, attempt, response.status);
      }
      if (response.status === 204 || method === "HEAD") return null;
      try { return await response.json(); }
      catch (error) {
        const transient = ["TypeError", "AbortError", "TimeoutError"].includes(error?.name);
        if (transient && attempt < attempts) continue;
        throw new ReleaseGitHubRequestError(transient ? "response-transport-failure" : "invalid-json", method, attempt, response.status);
      }
    }
  }
  const get = (path) => async (params) => ({ data: await request(path(params)) });
  const base = `/repos/${repository}`;
  const github = { rest: { git: { getRef: get(({ ref }) => `${base}/git/ref/${ref}`) }, actions: {
    listWorkflowRuns: get((p) => `${base}/actions/workflows/${p.workflow_id}/runs?branch=${p.branch}&head_sha=${p.head_sha}&per_page=100&page=${p.page ?? 1}`),
    listJobsForWorkflowRun: get((p) => `${base}/actions/runs/${p.run_id}/jobs?filter=${p.filter}&per_page=100&page=${p.page ?? 1}`),
    getWorkflowRun: get((p) => `${base}/actions/runs/${p.run_id}`),
    createWorkflowDispatch: async ({ workflow_id, ...parameters }) => ({ data: await request(`${base}/actions/workflows/${workflow_id}/dispatches`, { method: "POST", body: { ref: parameters.ref, inputs: parameters.inputs } }) }),
  } }, async paginate(method, parameters) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const { data } = await method({ ...parameters, page });
      const items = Array.isArray(data) ? data : data.workflow_runs ?? data.jobs;
      must(Array.isArray(items), "invalid paginated response"); all.push(...items);
      if (items.length < 100) return all;
    }
    throw new Error("Release runtime: API pagination exceeded safety limit");
  } };
  return { request, github, repo: { owner, repo } };
}

/** Preserve PR12 run/job recovery, but persist dispatch intent before the write.
 * An unresolved dispatch can only be reconciled by seeing its matching run. */
export async function reconcileReleasePages({ github, core, repo, journal, commit }) {
  const { reconcilePagesDeployment } = await import("../reconcile-pages-deployment.mjs");
  const wrapped = { ...github, rest: { ...github.rest, actions: { ...github.rest.actions,
    async createWorkflowDispatch(parameters) {
      const state = await journal.read();
      must(!state.pages || state.pages.status !== "intent", "previous Pages dispatch is unresolved; read-only reconciliation required");
      state.pages = { status: "intent", commit };
      await journal.write(state);
      return github.rest.actions.createWorkflowDispatch(parameters);
    },
  } } };
  const result = await reconcilePagesDeployment({ github: wrapped, core, repo, targetSha: commit });
  const state = await journal.read();
  state.pages = { status: "confirmed", commit, runId: result.runId };
  await journal.write(state);
  return result;
}

/** Actions runners have ephemeral disks. Existing Actions attempt records are
 * the conservative durable fence: an earlier failed/interrupted release step
 * authorizes read-only reconciliation only. An operator may name exact reviewed
 * run:attempt pairs in a manual dispatch after resolving their uncertain writes.
 * This is intentionally conservative, including failures before any write. */
export async function createActionsReleaseMutationGuard({ repository, request, runId, runAttempt, resolvedAttempts = "" }) {
  let phase = "identity", context = {};
  const check = (value, reason) => { if (!value) throw new ActionsHistoryError(phase, context, { kind: "invalid-history", reason }); };
  const readHistory = async (path, nextPhase, nextContext) => {
    phase = nextPhase; context = nextContext;
    try { return await request(path); }
    catch (error) {
      throw new ActionsHistoryError(phase, context, error instanceof ReleaseGitHubRequestError ? error.details : { kind: "request-failed" });
    }
  };
  check(/^\d+$/u.test(String(runId)) && /^\d+$/u.test(String(runAttempt)), "Actions run identity is required");
  const resolved = new Set(resolvedAttempts ? resolvedAttempts.split(",").map((item) => item.trim()) : []);
  check([...resolved].every((item) => /^[1-9]\d*:[1-9]\d*$/u.test(item)), "reviewed attempts must be exact run:attempt pairs");
  const base = `/repos/${repository}`;
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const result = await readHistory(`${base}/actions/workflows/sync-archive.yml/runs?branch=main&per_page=100&page=${page}`, "runs", { page });
    check(Array.isArray(result?.workflow_runs), "Actions history is unavailable");
    runs.push(...result.workflow_runs);
    if (result.workflow_runs.length < 100) break;
    check(page < 10, "Actions history reached the search limit; cannot prove restart safety");
  }
  check(runs.some((run) => run.id === Number(runId)), "current Actions run is missing from history");
  const blocked = new Set(); const observed = new Set(); const previouslyReviewed = new Set();
  for (const run of runs.filter((item) => Number.isSafeInteger(item.id) && item.id <= Number(runId))) {
    for (let page = 1; page <= 100; page++) {
      const result = await readHistory(`${base}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`, "jobs", { runId: run.id, page });
      check(Array.isArray(result?.jobs), "Actions attempt history is unavailable");
      for (const job of result.jobs.filter((item) => item.name === "release-sync")) {
        check(Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0, "Actions attempt identity is unavailable");
        if (run.id === Number(runId) && job.run_attempt >= Number(runAttempt)) continue;
        const step = job.steps?.find((item) => item.name === "Fully materialize, validate, accept and recover publication");
        if (!step || step.conclusion === "skipped" || step.status === "queued") continue;
        const key = `${run.id}:${job.run_attempt}`; observed.add(key);
        if (step.conclusion !== "success" && !resolved.has(key)) blocked.add(key);
        if (step.conclusion === "success" && run.event === "workflow_dispatch") {
          const record = job.steps.find((item) => item.conclusion === "success" && item.name.startsWith("Operator-reviewed release attempts: "));
          if (record) {
            for (const item of record.name.slice("Operator-reviewed release attempts: ".length).split(",").map((part) => part.trim())) {
              check(/^[1-9]\d*:[1-9]\d*$/u.test(item), "invalid persisted operator resolution"); previouslyReviewed.add(item);
            }
          }
        }
      }
      if (result.jobs.length < 100) break;
      check(page < 100, "Actions attempt history exceeds safety limit");
    }
  }
  phase = "resolution"; context = {};
  for (const key of previouslyReviewed) { check(observed.has(key), "reviewed Actions history is incomplete"); blocked.delete(key); }
  check([...resolved].every((key) => observed.has(key)), "a reviewed run:attempt was not found in complete Actions history");
  return {
    blockedAttempts: [...blocked].sort(),
    assertMutationAllowed() {
      must(blocked.size === 0, `previous release attempts need read-only reconciliation: ${[...blocked].sort().join(", ")}. Resolve exact attempts before authorizing new writes`);
    },
  };
}

/** Report current accepted-main recovery state using reads only. A blocked run
 * remains blocked even when one component was already completed elsewhere. */
export async function inspectAcceptedReleaseRecovery({ root, repository, transport, store, request, github, repo }) {
  const report = { status: "blocked", acceptedCommit: null, releaseId: null, auditPublication: "unverified", pages: "unverified", freshSourceReplay: false };
  try {
    const { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint } = await import("./accepted-git.mjs");
    const commit = await transport.fetchMain();
    const checkpoint = await readVerifiedAcceptedCheckpoint(await loadAcceptedGitCheckpoint({ root, repository, commit }));
    report.acceptedCommit = commit;
    if (!checkpoint.manifest) { report.auditPublication = "not-accepted"; report.pages = "not-accepted"; return report; }
    report.releaseId = checkpoint.manifest.releaseId;
    try {
      await store.readBundle({ receipt: checkpoint.manifest.auditReceipt });
      const release = await request(`/repos/${repository}/releases/${checkpoint.manifest.auditReceipt.releaseId}`);
      must(release.id === checkpoint.manifest.auditReceipt.releaseId && typeof release.draft === "boolean", "invalid publication observation");
      report.auditPublication = release.draft ? "pending" : "published";
    } catch { /* Never call a missing or unverified asset published. */ }
    const { reconcilePagesDeployment } = await import("../reconcile-pages-deployment.mjs");
    const readOnly = { ...github, rest: { ...github.rest, actions: { ...github.rest.actions,
      async createWorkflowDispatch() { const error = new Error("Pages dispatch pending"); error.code = "PAGES_PENDING"; throw error; },
    } } };
    const core = { info() {}, summary: { addRaw() { return this; }, async write() {} } };
    try {
      const result = await reconcilePagesDeployment({ github: readOnly, core, repo, targetSha: commit });
      report.pages = result.state === "already deployed" ? "deployed" : "queued"; report.pagesRunId = result.runId;
    } catch (error) { if (error.code === "PAGES_PENDING") report.pages = "pending"; }
  } catch { /* No source acquisition, guessing, or recovery writes on failure. */ }
  return report;
}
