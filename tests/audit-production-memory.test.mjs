import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";

const source = await readFile(new URL("../scripts/build-audit-production.mjs", import.meta.url), "utf8");
const body = source.slice(source.indexOf("let candidate = await buildAcceptedCandidate"), source.indexOf("console.log("));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function exercise({ bundleId = "approved", verifyError = false, tampered = false, extraFile = false } = {}) {
  const calls = [], bytes = Buffer.from("approved bytes");
  const plan = { bundleId: "approved", files: { "candidate.json": { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } };
  // Inspect the actual wrapper's live binding at entry to its independent verifier.
  const instrumented = body.replace("await verifyAcceptedCandidate(root,output,options);", "assert.equal(candidate, null); await verifyAcceptedCandidate(root,output,options);");
  const run = new AsyncFunction("assert", "buildAcceptedCandidate", "verifyAcceptedCandidate", "must", "root", "options", "plan", "readdir", "mkdir", "readFile", "copyFile", "createHash", instrumented);
  const promise = run(assert, async () => ({ output: "/candidate", manifest: { bundleId }, artifacts: { large: true }, acceptedFiles: { large: true } }),
    async (root, output, options) => { calls.push("verify"); assert.equal(root, "/root"); assert.equal(output, "/candidate"); assert.deepEqual(options, { bound: true }); if (verifyError) throw new Error("Replay rejected"); },
    value => assert.ok(value), "/root", { bound: true }, plan,
    async () => extraFile ? ["candidate.json", "extra"] : ["candidate.json"], async () => { calls.push("mkdir"); },
    async () => tampered ? Buffer.from("tampered bytes") : bytes,
    async (from, to) => { assert.equal(from, "/candidate/candidate.json"); assert.equal(to, "/build/bundle/candidate.json"); calls.push("copy"); }, createHash);
  return { promise, calls };
}

test("producer releases materialized candidate before full independent verification and exact-byte copy", async () => {
  assert.match(body, /candidate = null;\s*await verifyAcceptedCandidate/u);
  assert.doesNotMatch(body.slice(body.indexOf("candidate = null;") + "candidate = null;".length), /candidate\./u);
  const { promise, calls } = await exercise(); await promise;
  assert.deepEqual(calls, ["verify", "mkdir", "copy"]);
});
for (const options of [{ bundleId: "wrong" }, { verifyError: true }, { tampered: true }, { extraFile: true }]) {
  test(`producer fails closed without copy: ${JSON.stringify(options)}`, async () => {
    const { promise, calls } = await exercise(options);
    await assert.rejects(promise);
    assert.ok(!calls.includes("copy"));
    if (options.bundleId) assert.ok(!calls.includes("verify"));
  });
}
