# Reviewed Actions audit successor

This operational branch does not advance accepted main, the Stage H proposal,
the source submodule, the candidate bytes or its existing draft Release. Its
version of the already registered `sync-archive.yml` adds dispatch-only successor
jobs. Existing archive sync, acceptance, publication, Pages and notification
jobs remain present for their regression tests and are explicitly main-only, so
none can execute on the successor branch.

The user's authorization at 2026-10-09T11:12:54Z permits this temporary-token
adapter and one new manifest convergence attempt. The original journal remains
unknown. The exhausted recovery's exact POST/uploads.github.com/401/request-ID
evidence supports adjudicating that attempt as rejected; it does not settle the
first unknown operation or reopen the old recovery allocation. All original
bytes are committed under `audit-recovery/stage-h/` and copied into persistent
Git evidence records before inspecting an upload as recovered.

Freeze the implementation as an operator commit, then add only `authority.json`
in a separate commit. The authority names the operator SHA and SHA256 inventory
of scripts, workflow, package files and evidence. Independently review that
final commit and run CI. Dispatch only the exact reviewed branch head, passing
the canonical authority SHA256 as the existing `source_review` input. The
adapter checks that input, actor and triggering actor, workflow path/ref/SHA,
run attempt, clean tree, and the single-file difference from the operator commit.
Existing local CLI Actions rejections are intentionally retained.

The build container receives no GitHub/Actions credentials or Docker socket.
The initial dispatch `37929002037` failed in independent replay while downloading
the historical checkpoint (HTTP 403; the particular URL/cause is not established).
Its upload job was skipped. `failed-read-only-build.json` preserves this outcome.
This did not obtain an upload reservation. A new reviewed dispatch, never a rerun
of that attempt, must verify its completed failure and skipped writer, zero audit
assets and zero authority refs before any evidence or upload writes. Ordinal 1
and all existing uncertain-operation records remain unchanged.

A trusted operator step now uses the read-only job token and original release
store to fetch/verify the seven historical assets against the exact accepted Git
checkpoint. It imports no proposal code, installs no dependencies, and writes
only verified data into a separate directory. The container receives this data
as a read-only mount; no token or HTTP response headers are retained. Its offline
store accepts only the exact Git checkpoint receipt, rechecks every file and the
manifest on each build/replay read, and has no network fallback. The ordinary
accepted-candidate verifier still checks the full checkpoint semantic bindings.
Its Node image and actions are digest/SHA pinned. The builder has an explicit
4 GiB V8 heap within a 6 GiB container limit, matching the successful local
operator runtime budget without changing the candidate runtime binding.
The recipe's `generatedAt` string is copied exactly from the frozen manifest;
it is never regenerated from Git's version-dependent `%cI` formatting. The
frozen spelling is `2026-09-29T01:05:06Z`, including the final `Z`.
It reconstructs the frozen
proposal from public source and public accepted history, runs npm ci and an
independent candidate replay, then compares all seven byte counts and SHA256s.
Actions artifacts transfer only these fixed data files between jobs. The writer
uses a fresh runner with no npm installation, proposal execution or shared
cache; its token is supplied only to the reviewed adapter step. It runs the same
release store uploader and download/hash/ID verification used by local recovery.

The remote execution fence is a create-only tag ref pointing to an immutable Git
record object. Its name binds repository, Release, asset and fixed successor
ordinal 1, never run ID, authority hash or operator SHA. Only the current create
request's 201 plus exact readback grants an upload capability. Existing refs,
422, lost responses and failed readbacks stop. Ref creation is never retried.
Outcome records are separate create-only refs. This is protocol append-only,
not protection against an administrator intentionally deleting repository data.
No lease expiration, cleanup or rerun can restore an upload allocation.

After manifest verification, the original pending operation is reconciled only
by the release store's positive download/hash proof. Each of the six remaining
uploads has its own fixed durable intent/outcome and repeats frozen binding
checks. Any upload 401 or uncertain transport result stops even if subsequent
read-only reconciliation finds matching bytes. The manifest's existing 422
race handling still requires independent full download verification. Receipt
creation requires all seven exact assets; the verified receipt is retained as
a separate evidence record. Local canonical migration preparation must then
reconcile its retained original journal, independently replay and read this
same Release to construct the combined commit. Normal final gates, merge and
recover-only publication remain separate requirements.

Writer permissions are repository `contents: write` and `actions: read`; build
has `contents: read`. There is no PAT, environment secret, admin permission or
workflow-writing token inside the runner. Publishing this operational workflow
branch may require workflow-write permission on the existing external caller.
If that permission is absent, stop and report; do not replace credentials.

Tests cover competing runners, lost create responses, readback failure, runner
loss, exhausted outcomes, changed run/authority, and the actual release store's
complete seven-asset flow and later-asset 401 stop/persistence cases. They model
GitHub's create-ref uniqueness; they do not simulate physical storage failure.
