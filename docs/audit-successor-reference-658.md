# Reference 658: source binding and historical upload convergence

This change does not authorize a workflow dispatch. No successor authority is
checked in. The original journal, Release and candidate are retained unchanged.

## Frozen incident

| Binding | Original value |
| --- | --- |
| Repository | `BillShiyaoZhang/bedtimenews-kg` |
| Accepted main | `871aec7774c4f3acb9c4f7591107c2131dba50df` |
| Proposal | `418ab403c0871c806e7cadaa74737a736b72ab3a` |
| Proposal ref | `refs/heads/fix/reference-658-entity-20261010` |
| Source | `c9a22c186104aa9b81eb566af6e5a4f6222801a6` |
| Proposal source gitlink | `18aefdb62ddae1ac020b6ee833cbb3c579137a8e` |
| Candidate bundle | `3ddb44d44be0f6935d70a595dbe43617fc4e80e2a91a62f1ba1483ceab779807` |
| Draft Release | `409240538` |
| Original journal | 516 bytes, SHA256 `9271441efdb736c108953c3c99970a77c2f76d05343b109c7dd8f7047d7949a5` |
| Original migration review | 12105 bytes, SHA256 `41db5052b365906d08c2a248d32b7ec61dad05bae6ed14af76c5e28aa4d0d9e5` |
| Frozen scope | SHA256 `d747f01f410612eb876748fd7c6cddcb97dde7c38d64f47bfba727b4adf19f9d` |

`audit-recovery/reference-658/scope.json` binds the complete original journal,
migration review, recipe, proposal and all seven asset hashes and lengths
(88,152,922 bytes total). Its reconstruction plan is historical input data, not
new authorization. Original evidence recorded `HTTP_ERROR / 401`; original
method, host and request ID were not captured. Do not synthesize these fields or
reuse Stage H authorization, request IDs, retry adjudications or build evidence.

## Source compatibility

The ordinary trusted snapshot producer remains exact-base main-only. Its
credential-free container now clones the fixed official source repository and
checks out the exact reviewed source commit before running proposal code. Both
checkout and reconstruction verify proposal/main/source and the fixed source
URL. The live combined-head check permits only the named source gitlink to become
the exact reviewed source SHA; all other code entries stay identical to proposal.
Receipt, predecessor, proposal and candidate bindings remain mandatory.

## Separate successor authority

After this operator is reviewed and merged, an explicitly approved canonical
`audit-successor-authority.json` may be stored as a Git data blob in a separate
commit. Dispatch requires that commit and the exact canonical bytes SHA256. The
authority has exactly these fields:

```json
{
  "schemaVersion": 1,
  "kind": "explicit-same-release-successor-authority",
  "scopeSha256": "d747f01f410612eb876748fd7c6cddcb97dde7c38d64f47bfba727b4adf19f9d",
  "operatorCommit": "<exact reviewed main merge SHA>",
  "expectedMain": "<same exact main SHA>",
  "successorOrdinal": 1,
  "originalStateRemainsUnknown": true,
  "purpose": "historical-convergence-only",
  "authorizedAt": "<actual new explicit authorization timestamp>",
  "reason": "<actual approved scope; never copy an older authorization>"
}
```

The example is deliberately invalid and cannot be executed. Canonical JSON plus
one newline is required. The actual authority must be created only after new
explicit approval; the authorization timestamp must not be invented.

The separate `audit-successor.yml` workflow runs only from exact main, actor
18454625, first run attempt. Trusted history checks current main, original base
ancestry, original proposal ref and the exact mutable draft. It reads the original
accepted ancestor explicitly. Only the isolated historical reconstruction
container pins its local `origin/main` reference to that original base; the live
operator continues to require current main to equal the new authority's exact
operator SHA. Neither this ref pin nor the historic result can enter the ordinary
trusted PR snapshot path.

Proposal code runs only in a credential-free container, with read-only operator
and approved-input mounts. The fresh writer runs trusted operator code, performs
no package install and never imports proposal code or executes artifact files.
It uses only the existing Actions temporary token and repository approval gates.

Each exact asset has a fixed ordinal-1 create-only Git-ref fence keyed by
repository, Release ID and asset name. Only a current 201 response plus exact
readback grants one attempt. Existing refs, lost creation responses, 422 on fence
creation, or failed readback stop. Run ID, restart and new authority cannot
replenish the budget. References are append-only by protocol, not administrator-
proof immutable storage.

An existing uploaded asset must pass full download/hash validation without POST.
An asset POST returning 422 may converge only through exact same-name byte/ID
readback. A starter, wrong bytes, 401, timeout or other uncertain result stops;
there is no delete, replacement or blind retry. Every later asset uses its own
fixed fence. Complete real readback of all seven assets and final frozen-state
checks precede a historical result. Original journal bytes are never modified.
New intent/outcome records describe the successor, not the fate of the original
request. The result explicitly has `accepted:false`, `snapshotEligible:false`
and `originalState:unknown`.

## Minimal approval and execution order

1. Review and validate this infrastructure-only PR. Ordinary merge preserves the
   original accepted data and produces new main **M**. No release upload runs on
   push or PR; both audit workflows require explicit dispatch.
2. If historical convergence is approved, create the new exact authority bound
   to **M** and the unchanged scope above. While the original proposal ref still
   equals `418ab…`, dispatch the historical successor once. Keep Release
   `409240538` draft, retain its original journal and all authority/fence evidence.
   Any uncertain write stops the sequence for reconciliation; do not advance the
   proposal ref or silently continue with another candidate.
3. Only after the historical step has positively converged (or a separately
   explicit decision approves leaving it unresolved), merge **M** into the existing
   proposal branch, retaining `418ab…` as an ancestor. Call this reviewed code head
   **Q**. Source stays fixed at `c9a22c…`; do not follow upstream HEAD.
4. Re-run read-only migration preview against **M/Q**, re-review its exact binding
   and generate a new candidate **B**. The old review remains a historical record;
   do not change its timestamp or transplant its old main/proposal binding.
   Compare old/new graph and news byte projections, semantic diff, source, review,
   generated time, seven asset hashes/lengths and receipt predecessor. Infra files
   do not change extraction semantics. Any substantive data or risk change stops
   for separate review.
5. **B necessarily differs from the old bundle** because main/proposal/review
   bindings changed. Its new draft audit package is a separately authorized
   migration, not an unknown-upload retry. Record the full old→new map before any
   new package write. Dispatch the ordinary exact-base trusted producer only for
   this approved new **M/Q/B** plan. Never feed it the original local pending journal
   or claim that it resolves that journal.
6. Build the true receipt and combined commit from **Q**, run all required,
   coverage, validation, lint/types and both builds, then push to PR30. Verify the
   precise combined head through trusted live readback and wait for all remote
   gates. Ordinary merge must preserve original proposal ancestry. Verify Pages,
   run only approved recover-only publication for the accepted new Release, and
   verify deployed data/version/assets against the accepted record.

The new **M/Q/review/B** hashes cannot honestly be supplied before the actual
infrastructure merge and new preview. Approval must explicitly cover this bounded
re-binding and a new audit package, or publication must wait for approval of that
concrete package. Old Release `409240538`, old pending journal, PR30 and all earlier
historical drafts are retained; none is deleted or silently relabeled.
