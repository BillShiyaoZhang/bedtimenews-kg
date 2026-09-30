import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { activeSnapshot, candidateRuntimeBinding } from "../scripts/lib/candidate-run.mjs";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { ACCEPTED_SEMANTIC_GENERATOR_FILES, acceptedSemanticSnapshot, migrationReviewBinding, validateMigrationReview, rollbackSourcePlan } from "../scripts/lib/accepted-transition.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const hash = (value) => sha256(canonicalJson(value));
const time = "2026-01-03T00:00:00Z";

test("semantic bindings include extraction dependencies and exclude unrelated operational modules", async () => {
  const snapshot = await activeSnapshot(root);
  const semantic = acceptedSemanticSnapshot(snapshot);
  const changedOperations = structuredClone(snapshot.inputs);
  changedOperations.generator.files["scripts/lib/release-sync.mjs"] = sha256("operational-only edit");
  changedOperations.generator.files["scripts/lib/new-deployment-helper.mjs"] = sha256("new operational helper");
  changedOperations.generator.sha256 = hash(changedOperations.generator.files);
  assert.deepEqual(acceptedSemanticSnapshot({ ...snapshot, inputs: changedOperations }).inputs.generator, semantic.inputs.generator);
  const changedExtraction = structuredClone(snapshot.inputs);
  changedExtraction.generator.files["scripts/lib/extraction.mjs"] = sha256("reviewed new extraction logic");
  assert.notEqual(acceptedSemanticSnapshot({ ...snapshot, inputs: changedExtraction }).inputs.generator.sha256, semantic.inputs.generator.sha256);
  const changedReports = structuredClone(snapshot.inputs);
  changedReports.generator.files["scripts/lib/accepted-reports.mjs"] = sha256("reviewed coverage calculation fix");
  assert.notEqual(acceptedSemanticSnapshot({ ...snapshot, inputs: changedReports }).inputs.generator.sha256, semantic.inputs.generator.sha256);
  const nonSemanticDependencies = new Set([
    "scripts/lib/accepted-git.mjs", // acceptance authority is pinned by codeCommit
    "scripts/lib/incremental.mjs", // imported by legacy-only C runner; E never appends
  ]);
  const listed = new Set(ACCEPTED_SEMANTIC_GENERATOR_FILES);
  for (const path of listed) {
    const code = await readFile(resolve(root, path), "utf8");
    for (const match of code.matchAll(/(?:from\s+|import\s*\()(["'])(\.[^"']+\.mjs)\1/gu)) {
      const dependency = posix.normalize(`${dirname(path)}/${match[2]}`);
      assert.ok(listed.has(dependency) || nonSemanticDependencies.has(dependency), `${path} introduced unclassified dependency ${dependency}`);
    }
  }
});

test("a Node patch drift is a reviewed runtime migration even when records are unchanged", async () => {
  const snapshot = acceptedSemanticSnapshot(await activeSnapshot(root));
  const oldRuntime = candidateRuntimeBinding();
  const patchRuntime = { ...oldRuntime, node: `${oldRuntime.node.split(".").slice(0, 2).join(".")}.${Number(oldRuntime.node.split(".")[2]) + 1}` };
  const { sha256: ignored, ...runtimePayload } = patchRuntime; void ignored;
  patchRuntime.sha256 = hash(runtimePayload);
  const recipe = { archiveCommit: "a".repeat(40), includedRoots: ["daily"] };
  const previousInputs = { ...snapshot.inputs, runtime: oldRuntime, recipe, sourceInventory: { sha256: sha256("inventory") }, sourceReview: { sha256: sha256("null\n") } };
  const oldVersions = { node: oldRuntime.node, icu: oldRuntime.icu };
  const inputs = { ...previousInputs, runtime: patchRuntime };
  const checkpoint = { manifest: { releaseId: "b".repeat(64), candidateBundleId: "c".repeat(64) } };
  const binding = migrationReviewBinding({ checkpoint, previous: { manifest: { inputs: previousInputs, versions: oldVersions } }, inputs,
    versions: { ...oldVersions, node: patchRuntime.node }, diff: { graph: { summary: { changed: 0 } } } });
  assert.notEqual(binding.fromHash, binding.toHash);
  assert.deepEqual(binding.from.configuration, binding.to.configuration);
  const review = { ...binding, reviewedAt: time, reason: "Review exact Node patch runtime drift and unchanged materialization diff" };
  assert.equal(validateMigrationReview(review, binding).kind, "reviewed-semantic-migration");
  assert.throws(() => validateMigrationReview({ ...review, to: binding.from }, binding), /old\/new axes/u);
});

test("rollback planning retains later tombstones and marks removed newer sources", () => {
  const withdrawn = { status: "retracted", lastHash: sha256("later withdrawn"), reviewedAt: time, reason: "Explicit exclusion" };
  const plan = rollbackSourcePlan({ observedInventory: { "daily/old.md": sha256("old"), "daily/new.md": sha256("new") }, sourceStates: { "daily/later.md": withdrawn } },
    { observedInventory: { "daily/old.md": sha256("old") }, effectiveInventory: { "daily/old.md": sha256("old") }, sourceStates: {} },
    { reviewedAt: time, reason: "Select an earlier accepted projection" });
  assert.deepEqual(plan.sourceStates["daily/later.md"], withdrawn);
  assert.equal(plan.sourceStates["daily/new.md"].status, "deleted");
  assert.equal(plan.sourceStates["daily/new.md"].lastHash, sha256("new"));
});

test("adding the news-scoped identity axis preserves old receipt axes and requires a reviewed migration", async () => {
  const snapshot = acceptedSemanticSnapshot(await activeSnapshot(root));
  const previousInputs = { ...snapshot.inputs, runtime: candidateRuntimeBinding(), recipe: { archiveCommit: "a".repeat(40) }, sourceInventory: { sha256: sha256("inventory") }, sourceReview: { sha256: sha256("null\n") } };
  delete previousInputs.identityRegistry;
  const identityRegistry = { path: "data/entity-identities.json", sha256: sha256("reviewed identity registry") };
  const inputs = { ...previousInputs, identityRegistry };
  const checkpoint = { manifest: { releaseId: "b".repeat(64), candidateBundleId: "c".repeat(64) } };
  const versions = { node: process.versions.node, icu: process.versions.icu };
  const expected = migrationReviewBinding({ checkpoint, previous: { manifest: { inputs: previousInputs, versions } }, inputs, versions, diff: { identity: { changed: 0 } } });
  assert.equal(Object.hasOwn(expected.from.configuration, "identityRegistry"), false);
  assert.deepEqual(expected.to.configuration.identityRegistry, identityRegistry);
  assert.notEqual(expected.fromHash, expected.toHash);
  assert.equal(validateMigrationReview({ ...expected, reviewedAt: time, reason: "Introduce explicit reviewed news-scoped identities" }, expected).kind, "reviewed-semantic-migration");
});
