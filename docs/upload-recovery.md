# Explicit recovery of an uncertain audit upload

This operator-only API is separate from normal staging, migration preparation,
acceptance and publication. It is not enabled automatically by a pending journal.
It does not interpret an empty asset list as proof that an earlier request failed.
The operator CLI defaults to read-only inspection; execution requires an explicit
`--execute` flag and a separately reviewed canonical approval file. There is no
automatic retry.

## What the old diagnostics establish

An `UNCERTAIN_MUTATION` with an upload operation and `requestStatus: 401` binds the
failure to the upload operation's callback. That callback also performs GET
preflights before its POST. Historical logs without a request method/host cannot
identify which request produced the 401. A response body is not itself required
to establish a rejection, but sufficiently trustworthy attribution is required.
Do not declare the old request rejected-not-applied merely from this log shape.

New HTTP diagnostics retain only status, a fixed host category, method, and a
bounded GitHub request ID which cannot contain the supplied credential. Bodies,
arbitrary headers, signed URLs and transport error strings are never included.
The upload operation key remains the phase binding.

## Same-target convergence protocol

GitHub documents that uploading an already-uploaded filename returns 422 rather
than replacing the asset. It also documents that a 502 can leave a `starter`
asset. See the [release asset API](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset).
These contracts permit an explicitly reviewed same-name/same-bytes convergence
attempt; they do not guarantee success or authorize deleting a failed asset.
The protocol relies on GitHub enforcing name uniqueness. Local race simulations
exercise this contract; they are not empirical proof of server concurrency.

`store.recoverPendingUpload` requires one exact pending upload and a separate
review binding the repository, bundle and manifest hashes, target commit,
expected main, proposal ref, numeric release ID, asset name/size/hash, original
journal SHA-256 and path, retained recovery directory, operator recovery code
commit, review time and reason.
The operator CLI verifies its own code commit and clean checkout against the
review, enforces a recovery-only changed-file allowlist, and checks the frozen
migration checkout and pinned source. Direct API callers retain the same
responsibility; the API itself does not discover the operator Git checkout. Recovery does not retarget the audit or change the
frozen proposal anchor. Deploying any code into the migration proposal would
require the normal new-anchor review instead.

1. Validate local artifact hashes and inspect the exact remote draft, main,
   proposal and all asset metadata. Reject duplicates, unexpected files, starter
   states, wrong content, immutable/public releases and identity changes.
2. If the bound asset already exists, download and verify it, then reread release
   identity and asset IDs. This path performs no POST.
3. Otherwise, `createUploadRecoveryReservation` validates the original journal
   hash and pending binding. After creating the evidence directory it fsyncs every
   directory from that leaf through the filesystem root, including all parent
   directory entries, before an upload can proceed. It exclusively creates and
   fsyncs an exact original
   journal copy and a separate recovery intent. Their deterministic names bind
   the original operation, not a new random attempt ID. Concurrent callers and
   process restarts cannot reserve a second attempt in the retained directory.
4. Recheck the remote state after persistence, rehash the exact local bytes, and
   recheck again immediately before one POST through the existing store request
   implementation. The existing destination allowlist, inherited authentication
   and manual redirect behavior remain in force.
5. Success or 422 requires independent list/download verification of the exact
   asset ID, name, byte length and SHA-256, followed by another identity/ID check.
   A 422 with no valid visible asset is not success. Any other response, timeout
   or lost response stops the attempt without another POST.
6. Persist a separate outcome. The original journal and pending operation remain
   untouched even on success. Only a later authorized canonical read-only
   reconciliation may positively confirm the original pending operation; the
   saved original journal copy retains its unknown history.

No recovery path deletes, renames, overwrites, recreates or publishes anything.
There is no alternate uploader. Any future attempt after an unresolved recovery
requires new evidence and review; changing the recovery directory to obtain a
fresh reservation is prohibited. Preserve intent/outcome records, including
partial files after persistence failures. Do not clear them to obtain a retry.

## Operator execution boundary

Before real use, review this implementation and the exact approval document,
verify the original candidate and journal hashes, establish no active competing
operator, confirm current main/proposal/source, and retain the recovery evidence
outside disposable temporary storage. Use the already authorized credentials and
network route. The operator checkout can be reviewed separately from the frozen
migration proposal; the recovery review records that code's commit. No code or
binding is silently substituted into the migration.

A verified asset alone is not acceptance. Resume the original coherent migration
prepare only after canonical reconciliation confirms it. All remaining audit
readbacks, exact-tree tests/builds, remote CI, ordinary merge ancestry and fresh
accepted-Git publication gates still apply.

## CLI invocation

Run the reviewed operator checkout with the pinned Node runtime and the existing
process-scoped repository/storage activation settings. The only path argument is
the explicit canonical approval JSON. Without `--execute`, all network methods
are restricted to GET/HEAD, and the reservation callback cannot write evidence
or permit an upload:

```sh
node scripts/recover-audit-upload.mjs --approval=/absolute/path/to/approved-recovery.json
```

After coordination of the exact review, add `--execute` to that same command.
The CLI fixes the original journal to `<migrationRoot>/work/migration-pr-journal.json`
and evidence storage to `<migrationRoot>/work/upload-recovery`; it accepts no
uploader, module, credential, or alternate evidence directory override. It emits
only bounded binding/result metadata and never arbitrary exception text. A
read-only success with `requires-explicit-recovery` means preflight reached the
blocked reservation boundary; it is not authentication proof for POST.

The directory durability tests observe real fsync order and inject failures
after synchronization boundaries. They are not physical power-loss tests.
