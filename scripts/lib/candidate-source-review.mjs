import { canonicalJson, sha256 } from "./candidate-bundle.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const isHash = (value) => typeof value === "string" && HASH.test(value);
const OPERATIONS = ["revise", "delete", "retract", "restore"];
const ensure = (value, message) => { if (!value) throw new Error(`Candidate source review: ${message}`); };
const own = (object, key) => Object.hasOwn(object, key);
const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const reason = (value) => typeof value === "string" && value.trim().length > 0;

/** Calendar-valid ISO timestamp with an explicit timezone, not a local date. */
export function isSourceReviewTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return false;
  const [, y, m, d, h, minute, second, zone] = match;
  const year = Number(y); const month = Number(m); const day = Number(d);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number(h) < 24 && Number(minute) < 60 && Number(second) < 60 &&
    (zone === "Z" || (Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60)) && Number.isFinite(Date.parse(value));
}

/** Paths name visible Markdown content inside the fixed included-root scope. */
export function validateCandidateSourcePath(path, includedRoots) {
  ensure(typeof path === "string" && !/[\\:\x00-\x1f\x7f]/u.test(path) && path.endsWith(".md") &&
    path.split("/").length >= 2 && path.split("/").every((part) => part && !part.startsWith(".")) &&
    includedRoots.includes(path.split("/")[0]), `unsafe or out-of-scope source path: ${String(path)}`);
  return path;
}

export function validateCandidateSourceInventory(inventory, includedRoots) {
  ensure(object(inventory), "source inventory must be a path-to-SHA-256 object");
  canonicalJson(inventory);
  for (const [path, hash] of Object.entries(inventory)) {
    validateCandidateSourcePath(path, includedRoots);
    ensure(isHash(hash), `invalid source SHA-256: ${path}`);
  }
  return sorted(inventory);
}

export function validateCandidateSourceReview(review) {
  ensure(exactKeys(review, ["schemaVersion", "baselineBundleId", "baselineInventoryHash", "currentInventoryHash", "reviewedAt", "reason", "decisions"]), "review has missing or unknown fields");
  canonicalJson(review);
  ensure(review.schemaVersion === 1 && isHash(review.baselineBundleId) && isHash(review.baselineInventoryHash) && isHash(review.currentInventoryHash), "review requires schemaVersion 1 and exact bundle/inventory hashes");
  ensure(isSourceReviewTimestamp(review.reviewedAt) && reason(review.reason), "review requires an explicit valid ISO reviewedAt and reason");
  ensure(Array.isArray(review.decisions), "review decisions must be an array");
  const paths = new Set();
  for (const decision of review.decisions) {
    ensure(exactKeys(decision, ["path", "operation", "fromHash", "toHash", "reason"]), "decision has missing or unknown fields");
    ensure(typeof decision.path === "string" && OPERATIONS.includes(decision.operation) &&
      (decision.fromHash === null || isHash(decision.fromHash)) && (decision.toHash === null || isHash(decision.toHash)) && reason(decision.reason), "invalid source decision");
    ensure(!paths.has(decision.path), `duplicate or conflicting decisions: ${decision.path}`);
    paths.add(decision.path);
  }
  return review;
}

/**
 * Pure, exact-byte review gate. A withdrawal is an extraction-scope decision,
 * never a declaration that the source's assertions are false.
 *
 * sourceStates contains only withdrawn paths: {status: 'deleted'|'retracted',
 * lastHash, reviewedAt, reason}. Deleted paths remain tombstoned until an explicit
 * restore, whose fromHash is lastHash even if baseline observed bytes are absent.
 * Retractions survive physical deletion; delete on a retracted path retains its
 * original retraction metadata and lastHash. This slice only restores those exact
 * withdrawn bytes. Retract cannot also revise bytes, and withdrawn sources cannot
 * be revised: restore the original bytes first, then review an active revision.
 * Current reappearance of any absent tombstone requires restore. Restoring removes
 * the current state; callers retain the immutable decision in lifecycle history.
 */
export function planCandidateSourceReview({ baselineBundleId = null, baselineObservedInventory, baselineEffectiveInventory, baselineSourceStates = {}, currentInventory, includedRoots, review = null }) {
  ensure(Array.isArray(includedRoots) && includedRoots.length > 0 && includedRoots.every((root) => typeof root === "string" && /^[a-z][a-z0-9_-]*$/u.test(root)) && new Set(includedRoots).size === includedRoots.length, "includedRoots must be a fixed nonempty unique root list");
  ensure(baselineBundleId === null || isHash(baselineBundleId), "invalid baseline bundle ID");
  const before = validateCandidateSourceInventory(baselineObservedInventory, includedRoots);
  const effectiveBefore = validateCandidateSourceInventory(baselineEffectiveInventory, includedRoots);
  const observedInventory = validateCandidateSourceInventory(currentInventory, includedRoots);
  ensure(object(baselineSourceStates), "sourceStates must be an object");
  canonicalJson(baselineSourceStates);
  const states = new Map();
  for (const [path, state] of Object.entries(baselineSourceStates)) {
    validateCandidateSourcePath(path, includedRoots);
    ensure(exactKeys(state, ["status", "lastHash", "reviewedAt", "reason"]) && ["deleted", "retracted"].includes(state.status) && isHash(state.lastHash) && isSourceReviewTimestamp(state.reviewedAt) && reason(state.reason), `invalid inherited source state: ${path}`);
    ensure(state.status !== "deleted" || !own(before, path), `deleted source is still observed: ${path}`);
    ensure(!own(before, path) || before[path] === state.lastHash, `inherited source lastHash mismatch: ${path}`);
    states.set(path, { ...state });
  }
  const expectedEffectiveBefore = Object.fromEntries(Object.entries(before).filter(([path]) => !states.has(path)));
  ensure(canonicalJson(effectiveBefore) === canonicalJson(expectedEffectiveBefore), "baseline effective inventory differs from its observed inventory and withdrawal states");
  if (review !== null) {
    validateCandidateSourceReview(review);
    ensure(baselineBundleId !== null && review.baselineBundleId === baselineBundleId, "review baseline bundle ID mismatch");
    ensure(review.baselineInventoryHash === sha256(canonicalJson(before)), "review baseline inventory hash mismatch");
    ensure(review.currentInventoryHash === sha256(canonicalJson(observedInventory)), "review current inventory hash mismatch");
  }
  const decisions = new Map();
  for (const decision of review?.decisions ?? []) {
    validateCandidateSourcePath(decision.path, includedRoots);
    decisions.set(decision.path, { ...decision });
  }
  // The contract does not approve identity moves or newly duplicated bytes.
  // Legacy duplicate bytes at unchanged paths or exactly restored tombstoned
  // paths retain their original logical identities; no new duplicate is created.
  const exactRestore = (path, hash) => {
    const state = states.get(path); const decision = decisions.get(path);
    return Boolean(state && state.lastHash === hash && decision?.operation === "restore" &&
      decision.fromHash === state.lastHash && decision.toHash === hash);
  };
  const historicalPaths = new Map();
  for (const [path, hash] of [...Object.entries(before), ...[...states].map(([path, state]) => [path, state.lastHash])]) {
    if (!historicalPaths.has(hash)) historicalPaths.set(hash, new Set());
    historicalPaths.get(hash).add(path);
  }
  const currentHashes = new Map();
  for (const [path, hash] of Object.entries(observedInventory)) {
    if (before[path] !== hash && !exactRestore(path, hash)) {
      ensure(![...(historicalPaths.get(hash) ?? [])].some((oldPath) => oldPath !== path), `duplicate or possible rename is unsupported: ${path}`);
    }
    const peers = currentHashes.get(hash) ?? [];
    peers.push(path); currentHashes.set(hash, peers);
  }
  for (const paths of currentHashes.values()) {
    ensure(paths.length < 2 || paths.every((path) => before[path] === observedInventory[path] || exactRestore(path, observedInventory[path])), `duplicate current source bytes are unsupported: ${paths.join(", ")}`);
  }
  const changes = { added: [], modified: [], deleted: [], retracted: [], restored: [] };
  const applied = [];
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(observedInventory), ...states.keys(), ...decisions.keys()])].sort()) {
    const oldHash = before[path] ?? null; const newHash = observedInventory[path] ?? null;
    const state = states.get(path); const decision = decisions.get(path);
    const previousHash = oldHash ?? state?.lastHash ?? null;
    if (!state && oldHash === null && newHash !== null) {
      ensure(!decision, `unused decision on a safe new addition: ${path}`);
      changes.added.push(path);
      continue;
    }
    if (decision) {
      ensure(decision.fromHash === previousHash && decision.toHash === newHash, `decision source hash mismatch: ${path}`);
      const { operation } = decision;
      if (operation === "revise") {
        ensure(oldHash !== null && newHash !== null && oldHash !== newHash, `unused or invalid revise decision: ${path}`);
        ensure(!state, `withdrawn source must be restored with exact original bytes before revise: ${path}`);
      } else if (operation === "delete") {
        ensure(oldHash !== null && newHash === null, `unused or invalid delete decision: ${path}`);
        if (!state) states.set(path, { status: "deleted", lastHash: oldHash, reviewedAt: review.reviewedAt, reason: decision.reason });
      } else if (operation === "retract") {
        ensure(oldHash !== null && !state, `unused or invalid retract decision: ${path}`);
        ensure(newHash === null || newHash === oldHash, `retract cannot also revise source bytes; review an active revision first: ${path}`);
        states.set(path, { status: "retracted", lastHash: newHash ?? oldHash, reviewedAt: review.reviewedAt, reason: decision.reason });
        changes.retracted.push(path);
      } else {
        ensure(state && newHash !== null, `unused or invalid restore decision: ${path}`);
        ensure(newHash === state.lastHash, `restore requires exact withdrawn bytes; restore original bytes before reviewing an active revision: ${path}`);
        states.delete(path);
        changes.restored.push(path);
      }
      applied.push(decision);
    } else {
      ensure(oldHash === newHash, `source change requires exact review: ${path}`);
      ensure(oldHash !== null || state, `unused source decision: ${path}`);
    }
    if (oldHash !== null && newHash === null) changes.deleted.push({ path, acceptedHash: oldHash });
    else if (oldHash !== null && newHash !== oldHash) changes.modified.push({ path, acceptedHash: oldHash, currentHash: newHash });
  }
  const sourceStates = sorted(Object.fromEntries(states));
  const effectiveInventory = Object.fromEntries(Object.entries(observedInventory).filter(([path]) => !own(sourceStates, path)));
  const decisionSummary = Object.fromEntries(OPERATIONS.map((operation) => [operation, applied.filter((decision) => decision.operation === operation).length]));
  return {
    observedInventory, effectiveInventory, sourceStates, decisions: applied, decisionSummary, changes,
    review: review === null ? null : JSON.parse(canonicalJson(review)),
  };
}
