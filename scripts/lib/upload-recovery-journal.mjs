import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalJson, sha256 } from "./candidate-bundle.mjs";

// Separate, exclusive intent/outcome files. The original migration journal is
// read for binding only; it is never changed or inferred to mean "not applied".
export function createUploadRecoveryReservation({ directory, originalJournalPath, onDurabilityEvent = () => {} }) {
  const root = resolve(directory); const original = resolve(originalJournalPath);
  async function syncDirectory(path, phase) {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    // Observation only: the hook cannot replace or skip real fsync. Throwing
    // from it fails closed, which lets tests exercise each durability boundary.
    await onDurabilityEvent({ phase, path });
  }
  async function appendExclusive(path, value) {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(Buffer.isBuffer(value) ? value : `${canonicalJson(value)}\n`); await file.sync(); }
    finally { await file.close(); }
    await syncDirectory(root, "file-entry");
  }
  return async (approval) => {
    if (root !== approval.recoveryDirectory || original !== approval.originalJournalPath) throw new Error("Recovery evidence paths differ from reviewed binding");
    const stat = await lstat(original);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Original journal must be a regular unlinked file");
    const bytes = await readFile(original);
    if (sha256(bytes) !== approval.originalJournalSha256) throw new Error("Original journal hash changed");
    const journal = JSON.parse(bytes);
    if (journal.schemaVersion !== 1 || journal.repository !== approval.repository
      || journal.candidate?.bundleId !== approval.bundleId || journal.candidate?.targetCommit !== approval.targetCommit
      || canonicalJson(journal.pendingOperations) !== canonicalJson([approval.operation])) throw new Error("Original pending operation binding mismatch");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("Recovery directory must be canonical and real");
    // Persist every possibly new directory entry, including root's own entry in
    // its parent, before any upload reservation can be returned to the caller.
    for (let path = root; ; path = dirname(path)) {
      await syncDirectory(path, "directory-chain");
      if (dirname(path) === path) break;
    }
    const key = sha256(`${approval.repository}\n${approval.operation}`);
    // The name depends on the original operation, not a caller-selected attempt
    // ID: changing the review cannot silently obtain another upload attempt.
    await appendExclusive(resolve(root, `${key}.original.json`), bytes);
    await appendExclusive(resolve(root, `${key}.intent.json`), approval);
    return { recordOutcome: (outcome) => appendExclusive(resolve(root, `${key}.outcome.json`), outcome) };
  };
}
