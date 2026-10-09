import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createActionsUploadFence, successorFenceKey } from "../scripts/lib/actions-upload-fence.mjs";

const scope = { repository: "owner/repo", releaseId: 123, bundleId: "a".repeat(64), successorOrdinal: 1 };
function server() {
  const refs = new Map(), objects = new Map(); let next = 0;
  const behavior = { loseCreateResponse: false, badReadback: false, creates: 0 };
  const api = async (path, options = {}) => {
    const { body, method = "GET" } = options;
    if (method === "POST" && path === "/git/refs") {
      behavior.creates++;
      if (refs.has(body.ref)) throw new Error("422 existing ref");
      refs.set(body.ref, body.sha);
      if (behavior.loseCreateResponse) throw new Error("response lost");
      return {};
    }
    if (method === "POST") {
      const sha = (++next).toString(16).padStart(40, "0"); objects.set(sha, body); return { sha };
    }
    if (path.startsWith("/git/ref/")) {
      const ref = `refs/${path.slice(9)}`; const sha = refs.get(ref);
      if (!sha) { if (options.missing) return null; throw new Error("404"); }
      return { ref, object: { type: "commit", sha: behavior.badReadback ? "0".repeat(40) : sha } };
    }
    const sha = path.split("/").at(-1), value = objects.get(sha);
    if (path.startsWith("/git/commits/")) return { tree: { sha: value.tree } };
    if (path.startsWith("/git/trees/")) return value;
    if (path.startsWith("/git/blobs/")) return { encoding: "base64", content: Buffer.from(value.content).toString("base64") };
    throw new Error("unexpected request");
  };
  return { api, refs, behavior };
}
const fence = (s, run = 1, authority = "b".repeat(64)) => createActionsUploadFence({ api: s.api, scope, run: { id: run, attempt: 1 }, authoritySha256: authority });

test("two runner contenders grant exactly one upload capability", async () => {
  const s = server();
  const outcomes = await Promise.allSettled([fence(s, 1).reserve("same-manifest"), fence(s, 2).reserve("same-manifest")]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((x) => x.status === "rejected").length, 1);
});
test("lost 201 response burns the same operation across a fresh runner and authority", async () => {
  const s = server(); s.behavior.loseCreateResponse = true;
  await assert.rejects(fence(s).reserve("manifest"));
  s.behavior.loseCreateResponse = false;
  await assert.rejects(fence(s, 999, "c".repeat(64)).reserve("manifest"));
  assert.equal(s.refs.size, 1);
});
test("failed readback never grants upload, even on same-run re-entry", async () => {
  const s = server(); s.behavior.badReadback = true;
  await assert.rejects(fence(s).reserve("manifest"));
  s.behavior.badReadback = false;
  await assert.rejects(fence(s).reserve("manifest"));
});
test("runner loss after obtaining reservation never reopens upload budget", async () => {
  const s = server(); await fence(s).reserve("manifest");
  await assert.rejects(fence(s, 2).reserve("manifest"));
});
test("verified or unknown outcome is append-only and cannot reopen or overwrite intent", async () => {
  const s = server(); const reservation = await fence(s).reserve("manifest");
  await reservation.recordOutcome({ state: "unknown", requestStatus: 401 });
  await assert.rejects(reservation.recordOutcome({ state: "verified" }));
  await assert.rejects(fence(s, 2).reserve("manifest"));
  assert.equal(s.refs.size, 2);
});
test("exact original evidence is retained and reusable without granting an upload", async () => {
  const s = server(); const evidence = { originals: { journal: "{\"state\":\"unknown\"}\n", outcome: "401\n" } };
  const first = await fence(s).retainEvidence(evidence);
  assert.equal(await fence(s, 2).retainEvidence(evidence), first);
  assert.equal(s.behavior.creates, 1);
});
test("one fixed intent per asset and ordinal; new authority is not part of key", async () => {
  const s = server(); await fence(s).reserve("manifest"); await fence(s).reserve("kg");
  assert.notEqual(successorFenceKey(scope, "manifest"), successorFenceKey(scope, "kg"));
  assert.throws(() => successorFenceKey(scope, "manifest", 2));
  assert.equal(s.refs.size, 2);
});
test("Actions adapter cannot run as an ordinary local command", () => {
  assert.throws(() => execFileSync(process.execPath, ["scripts/actions-audit-successor.mjs"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, GITHUB_ACTIONS: "false" }, stdio: "pipe",
  }), (error) => {
    assert.match(error.stderr.toString(), /ADAPTER_REJECTED/u); return true;
  });
});
test("legacy local prepare and recovery Actions guards remain in place", () => {
  assert.match(readFileSync("scripts/prepare-migration-pr.mjs", "utf8"), /process\.env\.GITHUB_ACTIONS === "true"/u);
  assert.match(readFileSync("scripts/recover-audit-upload.mjs", "utf8"), /process\.env\.GITHUB_ACTIONS !== "true"/u);
});

test('successor dispatch cannot enter any original main writer or failure notification job', () => {
  const workflow = readFileSync('.github/workflows/sync-archive.yml', 'utf8');
  for (const name of ['sync', 'release-sync', 'notify-sync-failure']) {
    const section = workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/u)[0];
    assert.ok(section);
    const guard = section.split('\n').find((line) => line.startsWith('    if: '));
    assert.ok(guard.includes("github.ref == 'refs/heads/main'"));
  }
  const build = workflow.split('\n  reconstruct:\n')[1].split('\n  upload:\n')[0];
  assert.match(build, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(build, /contents: read/u);
  assert.doesNotMatch(build, /contents: write/u);
  const trustedRead = build.split('      - name: Read and verify historical audit using trusted operator code\n')[1].split('      - name: Reconstruct frozen bytes inside a credential-free container\n')[0];
  assert.match(trustedRead, /run: node scripts\/fetch-actions-checkpoint\.mjs/u);
  assert.doesNotMatch(trustedRead, /npm |proposal/u);
  assert.match(trustedRead, /GH_TOKEN: \$\{\{ github.token \}\}/u);
  const container = build.split('      - name: Reconstruct frozen bytes inside a credential-free container\n')[1];
  assert.doesNotMatch(container, /GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN/u);
  assert.match(container, /verified-checkpoint:\/checkpoint:ro/u);
  const writer = workflow.split('\n  upload:\n')[1].split('\n  release-sync:\n')[0];
  assert.doesNotMatch(writer, /npm ci|npm install|run:.*proposal/u);
  assert.match(writer, /persist-credentials: false/u);
});
