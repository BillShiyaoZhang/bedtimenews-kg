import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { isSourceReviewTimestamp, planCandidateSourceReview, validateCandidateSourceReview } from "../scripts/lib/candidate-source-review.mjs";

const hash = (value) => sha256(value);
const a = hash("a"); const b = hash("b"); const c = hash("c");
const bundleId = hash("immutable baseline bundle");
const reviewedAt = "2026-09-30T09:00:00Z";
const path = "daily/a.md";
const before = { [path]: a };
const state = (status = "retracted", lastHash = a) => ({ status, lastHash, reviewedAt, reason: "Reviewed extraction-scope withdrawal" });
const decision = (operation, fromHash = a, toHash = b, sourcePath = path) => ({ path: sourcePath, operation, fromHash, toHash, reason: "Exact transition reviewed" });
function options(currentInventory = before, overrides = {}) {
  return { baselineBundleId: bundleId, baselineObservedInventory: before, baselineEffectiveInventory: before, baselineSourceStates: {}, currentInventory, includedRoots: ["daily"], ...overrides };
}
function reviewed(input, decisions = []) {
  return { ...input, review: { schemaVersion: 1, baselineBundleId: input.baselineBundleId, baselineInventoryHash: hash(canonicalJson(input.baselineObservedInventory)), currentInventoryHash: hash(canonicalJson(input.currentInventory)), reviewedAt, reason: "Offline source transition only", decisions } };
}

// Pure tests deliberately do not read a worktree or accept data anywhere.
test("source review permits no-op and safe unique additions without mutation", () => {
  const input = options({ [path]: a, "daily/new.md": b });
  const copy = structuredClone(input);
  const result = planCandidateSourceReview(input);
  assert.deepEqual(result.observedInventory, input.currentInventory);
  assert.deepEqual(result.effectiveInventory, input.currentInventory);
  assert.deepEqual(result.sourceStates, {});
  assert.deepEqual(result.changes.added, ["daily/new.md"]);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(input, copy);
  assert.equal(result.review, null);
});

test("modified and deleted bytes fail closed without exact review coverage", () => {
  for (const inventory of [{ [path]: b }, {}]) {
    assert.throws(() => planCandidateSourceReview(options(inventory)), /requires exact review/u);
    assert.throws(() => planCandidateSourceReview(reviewed(options(inventory))), /requires exact review/u);
  }
  for (const entry of [decision("revise", c), decision("revise", a, c)]) {
    assert.throws(() => planCandidateSourceReview(reviewed(options({ [path]: b }), [entry])), /source hash mismatch/u);
  }
});

test("reviewed revision and deletion produce exact inventories and persistent tombstones", () => {
  const revised = planCandidateSourceReview(reviewed(options({ [path]: b }), [decision("revise")]));
  assert.deepEqual(revised.effectiveInventory, { [path]: b });
  assert.equal(revised.decisionSummary.revise, 1);
  assert.deepEqual(revised.sourceStates, {});
  const deleted = planCandidateSourceReview(reviewed(options({}), [decision("delete", a, null)]));
  assert.deepEqual(deleted.observedInventory, {});
  assert.deepEqual(deleted.effectiveInventory, {});
  assert.deepEqual(deleted.sourceStates, { [path]: { ...state("deleted"), reason: "Exact transition reviewed" } });
  assert.equal(deleted.decisionSummary.delete, 1);
});

test("retraction may leave bytes unchanged or review their exact absence", () => {
  for (const toHash of [a, null]) {
    const current = toHash === null ? {} : { [path]: toHash };
    const result = planCandidateSourceReview(reviewed(options(current), [decision("retract", a, toHash)]));
    assert.deepEqual(result.observedInventory, current);
    assert.deepEqual(result.effectiveInventory, {});
    assert.equal(result.sourceStates[path].status, "retracted");
    assert.equal(result.sourceStates[path].lastHash, toHash ?? a);
    assert.equal(result.decisionSummary.retract, 1);
    assert.deepEqual(result.changes.retracted, [path]);
    assert.ok(!canonicalJson(result).includes('"false"'));
  }
});

test("inherited retraction stays excluded through no-op and reviewed deletion", () => {
  const input = options(before, { baselineEffectiveInventory: {}, baselineSourceStates: { [path]: state() } });
  const unchanged = planCandidateSourceReview(input);
  assert.deepEqual(unchanged.sourceStates, input.baselineSourceStates);
  assert.deepEqual(unchanged.effectiveInventory, {});
  assert.throws(() => planCandidateSourceReview(reviewed({ ...input, currentInventory: { [path]: b } }, [decision("revise")])), /restored with exact original bytes before revise/u);
  const deleted = planCandidateSourceReview(reviewed({ ...input, currentInventory: {} }, [decision("delete", a, null)]));
  assert.deepEqual(deleted.sourceStates[path], state());
  const absent = planCandidateSourceReview(options({}, { baselineObservedInventory: {}, baselineEffectiveInventory: {}, baselineSourceStates: deleted.sourceStates }));
  assert.deepEqual(absent.sourceStates[path], state());
});

test("restoration requires exact unchanged or reintroduced withdrawn bytes", () => {
  for (const status of ["deleted", "retracted"]) {
    for (const oldPresent of [false, true]) {
      if (status === "deleted" && oldPresent) continue;
      for (const newHash of [a, b]) {
        const input = options({ [path]: newHash }, { baselineObservedInventory: oldPresent ? before : {}, baselineEffectiveInventory: {}, baselineSourceStates: { [path]: state(status) } });
        if (newHash !== a) {
          assert.throws(() => planCandidateSourceReview(reviewed(input, [decision("restore", a, newHash)])), /restore requires exact withdrawn bytes/u);
          continue;
        }
        const result = planCandidateSourceReview(reviewed(input, [decision("restore", a, newHash)]));
        assert.deepEqual(result.sourceStates, {});
        assert.deepEqual(result.effectiveInventory, { [path]: newHash });
        assert.deepEqual(result.changes.restored, [path]);
        assert.equal(result.decisionSummary.restore, 1);
        if (!oldPresent) {
          assert.throws(() => planCandidateSourceReview(input), /requires exact review/u);
          assert.throws(() => planCandidateSourceReview(reviewed(input, [decision("restore", null, newHash)])), /source hash mismatch/u);
        }
      }
    }
  }
});

test("review binding rejects stale baseline IDs, inventory hashes, and missing parent bundles", () => {
  const input = reviewed(options({ [path]: b }), [decision("revise")]);
  for (const key of ["baselineBundleId", "baselineInventoryHash", "currentInventoryHash"]) {
    assert.throws(() => planCandidateSourceReview({ ...input, review: { ...input.review, [key]: c } }), /mismatch/u);
  }
  assert.throws(() => planCandidateSourceReview({ ...input, baselineBundleId: null }), /bundle ID mismatch/u);
  assert.throws(() => planCandidateSourceReview(options(before, { baselineBundleId: "not-a-hash" })), /invalid baseline/u);
});

test("duplicates and possible renames are unsupported even if disappearance is reviewed", () => {
  for (const inventory of [
    { [path]: a, "daily/copy.md": a },
    { [path]: a, "daily/new1.md": b, "daily/new2.md": b },
  ]) assert.throws(() => planCandidateSourceReview(options(inventory)), /duplicate/u);
  assert.throws(() => planCandidateSourceReview(reviewed(options({ "daily/renamed.md": a }), [decision("delete", a, null)])), /rename/u);
  const tombstone = options({ "daily/renamed.md": a }, { baselineObservedInventory: {}, baselineEffectiveInventory: {}, baselineSourceStates: { [path]: state("deleted") } });
  assert.throws(() => planCandidateSourceReview(tombstone), /rename/u);
  const legacy = { [path]: a, "daily/existing-duplicate.md": a };
  assert.deepEqual(planCandidateSourceReview(options(legacy, { baselineObservedInventory: legacy, baselineEffectiveInventory: legacy })).effectiveInventory, legacy);
  const revisedCopy = options({ [path]: b, "daily/other.md": b }, { baselineObservedInventory: { [path]: a, "daily/other.md": b }, baselineEffectiveInventory: { [path]: a, "daily/other.md": b } });
  assert.throws(() => planCandidateSourceReview(reviewed(revisedCopy, [decision("revise")])), /duplicate/u);
});

test("unused, conflicting and misclassified decisions are rejected", () => {
  const revision = decision("revise");
  assert.throws(() => planCandidateSourceReview(reviewed(options({ [path]: b }), [revision, revision])), /conflicting/u);
  for (const entry of [decision("revise", a, a), decision("delete", a, a), decision("restore", a, a)]) {
    assert.throws(() => planCandidateSourceReview(reviewed(options(before), [entry])), /unused or invalid/u);
  }
  assert.throws(() => planCandidateSourceReview(reviewed(options(before), [decision("delete", null, null, "daily/unknown.md")])), /unused or invalid/u);
  assert.throws(() => planCandidateSourceReview(reviewed(options({ ...before, "daily/new.md": b }), [decision("retract", null, b, "daily/new.md")])), /unused decision/u);
  const retracted = options(before, { baselineEffectiveInventory: {}, baselineSourceStates: { [path]: state() } });
  assert.throws(() => planCandidateSourceReview(reviewed(retracted, [decision("retract", a, a)])), /unused or invalid/u);
});

test("review rejects incomplete coverage across multiple changed source paths", () => {
  const old = { [path]: a, "daily/other.md": b };
  const input = options({ [path]: c }, { baselineObservedInventory: old, baselineEffectiveInventory: old });
  assert.throws(() => planCandidateSourceReview(reviewed(input, [decision("revise", a, c)])), /requires exact review: daily\/other.md/u);
});

test("scope, inherited inventories, and persistent state are validated strictly", () => {
  for (const unsafe of ["../a.md", "/daily/a.md", "daily/../a.md", "daily//a.md", "daily\\a.md", "daily/a\0.md", "daily/.hidden.md", "main/a.md", "daily/a.txt", "daily/a:b.md"]) {
    assert.throws(() => planCandidateSourceReview(options({ [unsafe]: b })), /source path/u);
  }
  assert.throws(() => planCandidateSourceReview(options(before, { includedRoots: ["daily", "daily"] })), /includedRoots/u);
  assert.throws(() => planCandidateSourceReview(options(before, { baselineEffectiveInventory: {} })), /effective inventory/u);
  assert.throws(() => planCandidateSourceReview(options(before, { baselineSourceStates: { [path]: state("deleted") } })), /still observed/u);
  assert.throws(() => planCandidateSourceReview(options(before, { baselineEffectiveInventory: {}, baselineSourceStates: { [path]: state("retracted", b) } })), /lastHash mismatch/u);
  assert.throws(() => planCandidateSourceReview(options({ [path]: [a] })), /SHA-256/u);
  assert.throws(() => planCandidateSourceReview(options(before, { baselineEffectiveInventory: {}, baselineSourceStates: { [path]: { ...state(), extra: true } } })), /invalid inherited/u);
});

test("schema, reasons, exact nulls, and explicit calendar-valid ISO timestamps are required", () => {
  const review = reviewed(options({ [path]: b }), [decision("revise")]).review;
  assert.equal(validateCandidateSourceReview(review), review);
  for (const timestamp of ["2026-09-30", "2026-09-30T09:00:00", "2026-02-30T00:00:00Z", "2026-09-30T24:00:00Z", "2026-09-30T09:00:00+24:00", "2026-09-30T09:00:60Z", " "]) {
    assert.equal(isSourceReviewTimestamp(timestamp), false);
    assert.throws(() => validateCandidateSourceReview({ ...review, reviewedAt: timestamp }), /valid ISO/u);
  }
  for (const timestamp of [reviewedAt, "2024-02-29T23:59:59.123+05:30", "2000-02-29T00:00:00-08:00"]) assert.equal(isSourceReviewTimestamp(timestamp), true);
  for (const mutation of [{ schemaVersion: 2 }, { extra: true }, { reason: "  " }, { decisions: {} }, { baselineBundleId: [bundleId] }]) assert.throws(() => validateCandidateSourceReview({ ...review, ...mutation }));
  for (const mutation of [{ toHash: undefined }, { toHash: [b] }, { reason: "" }, { extra: true }, { operation: "erase" }]) assert.throws(() => validateCandidateSourceReview({ ...review, decisions: [{ ...decision("revise"), ...mutation }] }));
});

test("planning is deterministic and does not alias mutable review/state inputs", () => {
  const input = reviewed(options({ [path]: b }), [decision("revise")]);
  const expected = canonicalJson(planCandidateSourceReview(input));
  const result = planCandidateSourceReview(input);
  result.decisions[0].reason = "mutated output";
  result.review.reason = "mutated output";
  assert.equal(canonicalJson(planCandidateSourceReview(input)), expected);
  assert.deepEqual(planCandidateSourceReview(options({}, { baselineObservedInventory: {}, baselineEffectiveInventory: {} })).effectiveInventory, {});
});

test("retraction and restoration cannot hide an unreviewed source identity migration", () => {
  assert.throws(() => planCandidateSourceReview(reviewed(options({ [path]: b }), [decision("retract")])), /retract cannot also revise source bytes/u);
  const withdrawn = options({ [path]: b }, { baselineEffectiveInventory: {}, baselineSourceStates: { [path]: state() } });
  assert.throws(() => planCandidateSourceReview(reviewed(withdrawn, [decision("revise")])), /restored with exact original bytes/u);
  assert.throws(() => planCandidateSourceReview(reviewed(withdrawn, [decision("restore")])), /restore requires exact withdrawn bytes/u);
  // Restore exactly, then make a separate active revision subject to the runner's
  // news boundary/identity continuity check. The pure gate still pins each byte.
  const restored = planCandidateSourceReview(reviewed({ ...withdrawn, currentInventory: before }, [decision("restore", a, a)]));
  const revised = planCandidateSourceReview(reviewed(options({ [path]: b }, { baselineObservedInventory: restored.observedInventory, baselineEffectiveInventory: restored.effectiveInventory, baselineSourceStates: restored.sourceStates }), [decision("revise")]));
  assert.deepEqual(revised.effectiveInventory, { [path]: b });
});

test("legacy duplicate source identities can be deleted and exactly restored", () => {
  const other = "daily/b.md";
  const legacy = { [path]: a, [other]: a };
  const input = options({ [other]: a }, { baselineObservedInventory: legacy, baselineEffectiveInventory: legacy });
  const deleted = planCandidateSourceReview(reviewed(input, [decision("delete", a, null)]));
  const restoreInput = options(legacy, { baselineObservedInventory: deleted.observedInventory, baselineEffectiveInventory: deleted.effectiveInventory, baselineSourceStates: deleted.sourceStates });
  const restored = planCandidateSourceReview(reviewed(restoreInput, [decision("restore", a, a)]));
  assert.deepEqual(restored.observedInventory, legacy);
  assert.deepEqual(restored.effectiveInventory, legacy);
  assert.deepEqual(restored.sourceStates, {});
  assert.deepEqual(restored.changes.added, []);
  assert.deepEqual(restored.changes.restored, [path]);
  assert.throws(() => planCandidateSourceReview(restoreInput), /duplicate|requires exact review/u);
  assert.throws(() => planCandidateSourceReview(reviewed({ ...restoreInput, currentInventory: { [path]: b, [other]: a } }, [decision("restore", a, b)])), /exact withdrawn bytes/u);
  assert.throws(() => planCandidateSourceReview(reviewed(restoreInput, [decision("restore", b, a)])), /duplicate|hash mismatch/u);
});

test("both deleted legacy duplicate identities can restore together or successively", () => {
  const other = "daily/b.md";
  const legacy = { [path]: a, [other]: a };
  const input = options({}, { baselineObservedInventory: legacy, baselineEffectiveInventory: legacy });
  const deleted = planCandidateSourceReview(reviewed(input, [decision("delete", a, null), decision("delete", a, null, other)]));
  const restoreInput = options(legacy, { baselineObservedInventory: deleted.observedInventory, baselineEffectiveInventory: deleted.effectiveInventory, baselineSourceStates: deleted.sourceStates });
  const restored = planCandidateSourceReview(reviewed(restoreInput, [decision("restore", a, a), decision("restore", a, a, other)]));
  assert.deepEqual(restored.effectiveInventory, legacy);
  assert.deepEqual(restored.sourceStates, {});
  assert.deepEqual(restored.changes.restored, [path, other]);
  const first = planCandidateSourceReview(reviewed({ ...restoreInput, currentInventory: before }, [decision("restore", a, a)]));
  assert.deepEqual(first.effectiveInventory, before);
  assert.equal(first.sourceStates[other].status, "deleted");
  const second = planCandidateSourceReview(reviewed(options(legacy, { baselineObservedInventory: first.observedInventory, baselineEffectiveInventory: first.effectiveInventory, baselineSourceStates: first.sourceStates }), [decision("restore", a, a, other)]));
  assert.deepEqual(second.effectiveInventory, legacy);
  assert.deepEqual(second.sourceStates, {});
});

test("an exact tombstone restoration exemption never permits a new duplicate or rename", () => {
  const other = "daily/b.md";
  const legacy = { [path]: a, [other]: a };
  const deleted = planCandidateSourceReview(reviewed(options({}, { baselineObservedInventory: legacy, baselineEffectiveInventory: legacy }), [decision("delete", a, null), decision("delete", a, null, other)]));
  const base = options(legacy, { baselineObservedInventory: deleted.observedInventory, baselineEffectiveInventory: deleted.effectiveInventory, baselineSourceStates: deleted.sourceStates });
  assert.throws(() => planCandidateSourceReview(reviewed({ ...base, currentInventory: { ...legacy, "daily/new-copy.md": a } }, [decision("restore", a, a), decision("restore", a, a, other)])), /duplicate|rename/u);
  assert.throws(() => planCandidateSourceReview(reviewed({ ...base, currentInventory: { "daily/moved.md": a } }, [decision("restore", a, a, "daily/moved.md")])), /duplicate|rename/u);
  assert.throws(() => planCandidateSourceReview(reviewed({ ...base, currentInventory: { [path]: b, [other]: a } }, [decision("restore", a, b), decision("restore", a, a, other)])), /exact withdrawn bytes/u);
});
