# Reviewed audit snapshots

This infrastructure transports draft Release evidence into read-only PR validation.
It does not accept a candidate, merge a PR, publish a Release, or replace the final
live Release check. Existing migration, accepted-checkpoint and recover-only gates
remain authoritative.

## Authorization and ordering

1. Review and merge this infrastructure separately. Record exact main M.
2. Create/review proposal P descending from M with identical workflow files and
   unchanged accepted outputs. Run read-only migration preview; review the new
   binding and all generated differences. Prior-base reviews cannot be reused.
3. Build the reviewed candidate locally with Node 22.23.2, npm 10.9.9, en-US,
   UTC. Freeze all seven filenames, byte counts, SHA256 values and bundle ID.
4. Commit canonical `audit-production-plan.json` plus newline to a separate
   reviewed plan branch. Its schema is `validateProductionPlan` in
   `scripts/lib/audit-snapshot.mjs`; include the exact review and its byte hash,
   proposal/base/source, recipe timestamp, actor, runtime, storage approval,
   reason and review time. The plan SHA cannot self-reference its commit.
5. After explicit payload/storage approval, dispatch `audit-snapshot.yml` at
   main M with exact plan commit/hash and `operation=produce`. Only trusted main
   gets a writer token. Proposal/npm code executes in a separate container with
   no credentials. Wait for the exact run to finish successfully.
6. Canonical local migration prepare reads the real draft, creates the real
   receipt and accepted outputs, and validates the combined commit. Push that
   commit to the same proposal branch and create the draft PR.
7. The independent PR download job has `contents:read, actions:read`, runs the
   exact base helper and locates artifacts by bundle ID. It verifies every
   qualified successful producer run, approved Git plan bytes, archive digest,
   bounded eight-file extraction, real historical receipt and seven hashes.
   Conflicting eligible snapshots fail closed. It never executes archive code.
8. PR replay routes only the exact candidate receipt to verified local bytes;
   the exact accepted predecessor continues through the published Release
   reader. All source replay, code ancestry, allowed-file and output checks stay
   enabled. Snapshot receipt is not accepted Git authority.
9. After exact final-head CI passes, dispatch `operation=verify` with the same
   plan commit/hash and exact `combined_head`. This mode performs only HTTP GET
   against real Release storage, checks current main and proposal branch, and
   binds the receipt to a single-parent combined commit changing only accepted
   outputs. It does not upload assets or reserve another upload attempt.
10. Read the successful verify run's `snapshot.json`: require `operation=verify`,
    exact `verification.combinedHead`, base/proposal and receipt SHA256, in
    addition to successful PR CI on that same head. A produce snapshot is not
    final live-verification evidence. Recheck head/base, ordinary-merge preserving P,
    verify Pages, then canonical recover-only publication and online readback.

## Failure and evidence handling

Production uses create-only `kg-audit-production-<bundle>-intent/outcome-*` Git
refs. They preserve normal-stage operation records across runner loss. A lost
response stops that attempt. A later run restores unresolved operations and
uses the canonical store's read-only reconciliation. Absence is not success;
no run resets the operation budget. A prior positively reconciled operation
cannot be repeated if an asset later disappears. No evidence refs or historical
Releases are deleted. These refs are append-only by protocol, not administrator-
proof immutable storage.

Only successful producer runs at exact M, the fixed workflow path and approved
actor are eligible. Artifacts expire after at most 90 days; expiration or API
failure blocks validation. A later explicit verify dispatch may create a fresh
snapshot of the same real draft, with the same approved plan and receipt.
The first infrastructure PR can skip downloading only because its exact base
lacks the helper and its receipt bytes are unchanged. Changed receipts never
receive this bootstrap exception.

No personal token is added to Actions and no persistent repository permission is
changed. Workflow permissions are scoped to each job. Deployment remains in the
existing approved release recovery workflow. A new main, proposal, payload,
review or permission scope requires review before publication.
