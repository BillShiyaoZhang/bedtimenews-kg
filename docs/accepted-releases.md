# Accepted release lifecycle (E)

## Activation gates and verified production history

This repository completed its first accepted release on September 30, 2026.
[Sync run 36788236991](https://github.com/BillShiyaoZhang/bedtimenews-kg/actions/runs/36788236991)
succeeded; the accepted output commit was
`848bd8ab611e7dad2e2acc76c1cab0ed6b9bdf3e`, and
[Pages run 36789775976](https://github.com/BillShiyaoZhang/bedtimenews-kg/actions/runs/36789775976)
succeeded for that exact commit. The
[first public audit release](https://github.com/BillShiyaoZhang/bedtimenews-kg/releases/tag/kg-audit-f221cc97ce887daadb32d5da27560c5557e25cd50cc30654b3208d432d6ca390)
was published at 2026-09-30T23:11:23Z. These are historical verified outcomes,
not a promise that future runs or current variable settings are healthy.

The repository now contains an accepted receipt; the legacy update, rebuild and
bootstrap commands are not the maintenance path. The accepted-release workflow
still requires its explicit activation gates. In a new deployment, an operator
must separately approve and configure both repository variables (the local CLIs
read the equivalent explicit environment variables). A merged implementation
alone does not grant storage or publication approval:

- `KG_RELEASE_ACTIVATED=true`
- `KG_RELEASE_STORAGE_APPROVED=<exact owner/repository>`: audit staging in private
  draft GitHub Releases, followed by public publication only after acceptance

Draft Releases are visible to repository collaborators. Accepted audit assets can
be public. Unaccepted candidates never become public Releases. No additional public journal branch is created. Nothing deletes or
replaces Releases/assets. No permission expansion is added to Actions.

Production is pinned to Node **22.23.2**, `en-US` locale and UTC. A local Node 24
benchmark cannot be promoted into a production verification epoch.

## Commands and sequence

`npm run kg:release:sync` runs the complete gated path:

1. Fetch and pin accepted main; load accepted state from immutable Git objects
2. Reconcile outstanding acceptance/publication before acquiring upstream
3. Bootstrap E from the exact legacy accepted source inventory, without advancing
   upstream. An inconsistent legacy inventory requires separate review
4. On later runs, acquire upstream independently and pin it. Rebuild the complete
   derived graph; this never calls append-only acceptance helpers
5. Replay the complete candidate and bind any exact source review
6. Reuse the existing accepted version and gitlink on a semantic/source no-op
7. Stage and read back the draft audit; build exact state4/output/receipt payloads
8. Prepare an isolated single-parent commit. Validate that exact tree with ontology
   checks, output validation, required tests, lint, worker build and Pages build
9. Recheck raw sources, active configuration, review, audit bytes and expected main
10. Persist promotion intent, attempt one expected-base fast-forward, reread main
    (an explicit `--force-with-lease=refs/heads/main:<expectedBase>` supplies CAS;
    authenticated Git object checks prove the proposed commit has exactly that
    sole parent, so every allowed update is forward-only. There is no unguarded
    force, `+` refspec, fallback, rebase or hook override)
11. Load a fresh accepted Git capability, publish its draft, and reconcile Pages
    for exactly the accepted commit

`npm run kg:release:recover` performs accepted audit/Pages recovery without source
acquisition or fresh extraction. `--source-review=path` supplies an exact reviewed
source transition; missing review for destructive changes fails closed.

`npm run kg:release:migration:preview -- --output=work/migration-preview.json`
is a read-only entry point. It pins main, reads the accepted audit and fully
replays the prepared local source snapshot to produce exact old/new semantic and
runtime bindings plus a deterministic diff. It requires the pinned production
runtime and read access, but does not require storage-write activation. Its store
adapter rejects every non-GET/HEAD request. It never stages, accepts, pushes or
dispatches. The default output is `work/migration-preview.json`. Review the diff,
add `reviewedAt` and `reason` to the returned `reviewBinding`, save that review,
then use the separate gated PR-preparation command below. Normal source-update
main CAS rejects migrations before audit staging. A preview is not approval. Recompute it if any bound predecessor, config, runtime, source,
source review or diff changes.

`npm run kg:release:rollback -- --target=<exact accepted commit> --rollback-review=path`
creates a forward restoration within the same semantic/runtime epoch. It uses a
verified current checkpoint and verified accepted ancestor, restores exact target
KG/news bytes, and keeps newer dormant identities and source tombstones in the
new current-parent lifecycle. No raw-source replay is claimed or required. The
review must bind the current release/bundle, target commit/release/bundle, review
time and reason. The resulting commit still passes draft readback, isolated
validation/tests/lint/builds, exact-base acceptance, publication and Pages gates.
Manual sync Actions inputs expose bounded source reviews and same-epoch rollback.
Semantic migration preparation is a separate local operator command, so PR code
never receives release-write credentials in Actions. Scheduled runs do not invent
reviews.

After state4 or `data/accepted-release.json` exists, every legacy update, rebuild
and bootstrap entry point rejects before compiler, source or accepted-file writes.
Removing an activation variable cannot re-enable legacy acceptance.

## One coherent reviewed migration PR

There is no period where a semantic-code-only change is accepted on main while
rendering data from another configuration. Use this explicit operator sequence:

1. Land any workflow or `.gitmodules` changes separately. The proposal preflight
   requires these trees to equal pinned main; no Workflows:write permission is added
2. Create a non-main review branch descending from the exact accepted main. Commit
   the proposed semantic code/config changes, keeping all six accepted output
   files, receipt and source gitlink byte-identical to current main. Keep the
   tracked checkout and index clean
3. Run the read-only migration preview, inspect the complete deterministic diff,
   and save the exact review with `reviewedAt` and `reason`. The review can live
   under ignored `work/`. If committed to the proposal, freeze its final SHA after
   that commit. The review's content-based diff binding avoids a circular code SHA
4. Once draft storage is explicitly approved, run
   `npm run kg:release:migration:prepare -- --proposal=<SHA> --proposal-ref=refs/heads/<branch> --migration-review=work/review.json`.
   The proposed code SHA must already exist in the remote repository for GitHub
   draft staging; publishing/pushing that code branch is a separate authorized
   operator action. This command pins main, inspects the proposal, builds and
   independently replays the reviewed candidate, stages/readbacks its private
   draft, prepares a single-parent code+data commit, validates its exact tree, then
   rechecks sources, config, review, draft, main and proposal
5. Inspect the returned local commit. The command creates no PR and does not move
   main or the proposal branch, push, publish, dispatch or change permissions.
   Its PR-only descriptor cannot be used by the source-update main-CAS helper.
   Explicitly update/push the reviewed branch and use one ordinary reviewed PR
   containing both semantic changes and their regenerated matching data. Required
   CI validates the coherent merged tree. Use a normal merge commit that preserves
   the proposed code and prepared data commits; do not squash or rebase this PR.
   `manifest.codeCommit` must remain an ancestor of accepted main. If accepted main or the frozen proposal
   moves, regenerate and re-review; never automatically rebase the approval
6. After an authorized ordinary PR merge, run release recovery. Only a fresh
   accepted-main Git capability can publish that draft and reconcile Pages for the
   exact accepted commit. The draft stays collaborators-only before acceptance

The local command requires an exact `--proposal` SHA, exact non-main
`--proposal-ref`, and a `--migration-review` file. Optional `--source` selects the
already acquired local Git source checkout; `--source-review` binds explicit
source changes. Use the pinned runtime, install the proposal's locked dependencies,
and provide the approved repository/environment variables and existing token
through the normal local operator environment. It does not create credentials.

Its JSON result has `status: "prepared-for-review"`, `accepted: false`,
`requiresReviewedMerge: true`, `prepared.commit` (the local data-commit SHA),
`prepared.expectedMain`, frozen proposal identifiers, release/bundle IDs and the
validation outcome. These fields are evidence to inspect, not authorization to
push or merge.

Wrong/missing approval, a dirty or moved proposal, changed accepted files/receipt/
gitlink, workflow or source-remote edits, stale review, wrong runtime, missing
source history, or advanced main fail closed. A required validation failure after
staging can leave a private draft, but never changes an accepted/proposal branch.
Unknown upload outcomes remain in the local journal and require read-only
reconciliation. Do not delete/recreate or retarget assets to work around an error.
A changed proposal needs a newly bound candidate and rechecked review.

The audit target is the frozen proposed code SHA. Its `inputs.reviewProposal`
binding changes candidate identity across proposal anchors without pretending a
new timestamp is semantic data. The containing data commit is its child;
`manifest.codeCommit` is the proposal and `predecessor` is pinned accepted main.
The ordinary merge preserves this ancestry. No public pending-mode marker or
extra public journal branch is introduced.

## Crash and uncertainty behavior

Release mutation intents are persisted and fsynced to a retained local journal before the
write. The workflow uses existing Actions attempt records as a conservative restart
fence: an earlier failed or interrupted E step restricts later runs to read-only
reconciliation. No additional public branch or audit mirror is needed. Missing
history, ambiguous absence and unresolved operations fail closed. After inspecting
and resolving an exact attempt's mutations, an operator can use the manual
`resolved_attempts` input (`runId:attempt`, comma-separated); it is never set by
scheduled runs. This is deliberately conservative and can also require review
after a validation failure that did not actually write anything.

Operator resolution is a deliberate manual action, not a generic bypass: inspect
that exact run/attempt and its completed requests; pin current main; inspect the
deterministic draft tag and every visible asset ID/hash/size; verify any accepted
receipt and existing Pages run; establish that no writer/request remains in flight.
Do not mark an ambiguous absence resolved. Enter only those exact reviewed
`runId:attempt` pairs in a manual dispatch. A successful manual run records the
bounded resolution in its Actions step metadata so scheduled runs can verify it.
Missing/deleted history cannot be waived by an unknown run ID.

This conservative restart fence assumes Actions run/attempt history is retained.
API errors, a missing current run, unresolved requested IDs and search limits fail
closed. A previously unreferenced failed run that was externally deleted cannot
be discovered from an otherwise clean listing. Deleting history is never a valid
way to resolve an uncertain write; investigate the original operation instead.

The fixed-origin API client retries transient GET/HEAD failures at most four
times total, with 250 ms, 1 s and 2 s delays. Timeouts, interrupted response reads,
and HTTP 408/429/500/502/503/504 are eligible; authorization failures, missing
resources, malformed JSON and invalid history are not. A `Retry-After` value
outside the next bounded delay fails closed rather than being ignored. No POST
or other mutation is retried, including when its response is lost. Exhaustion
keeps the `history-unverified` fence. The CLI reports only safe phase, run/page,
failure category, HTTP status and attempt count, never remote response bodies or
transport error text. These diagnostics distinguish a transient read failure
from incomplete history without declaring any failed release attempt resolved.

A lost response is reconciled read-only. Unknown outcomes block additional
writes; starting a new process does not authorize a retry. A failed preparation,
validation or main race leaves accepted main unchanged, although its private draft
may remain for inspection. After acceptance, publication/Pages recovery reuses the
same commit and data version.

After creating a draft, the adapter validates the returned release metadata and
uses its numeric ID only to locate an independent GET readback. The tag endpoint
is for published releases, and a draft can be readable by ID before it appears in
the release listing. Creation reconciliation makes at most four readback attempts,
with delays of 250 ms, 1 s and 2 s after the first attempt. Only absent or transient
transport/server reads are retried; the create POST is never repeated. A lost
create response uses tag/list discovery under the same read-only bound. Conflicts,
unsafe URLs and incomplete/invalid listings still fail closed, and an exhausted
readback keeps the mutation intent unresolved.

For a failed bootstrap that left only an empty draft, keep that exact draft for
inspection. A transport-code repair merged into main changes the next bootstrap's
origin commit and therefore its candidate identity, even if semantic axes are
unchanged; do not retarget or relabel the old draft for the new candidate. Before
an authorized manual sync, recheck current main, the failed attempt's exact draft
and assets, and all intervening Actions attempts. Include every separately
reconciled blocking `runId:attempt` pair in `resolved_attempts`; a later blocked
scheduled run may add another pair. `recover_only` cannot bootstrap when no
accepted release exists. Code review/merge does not itself authorize that dispatch
or resolve the previous attempt.

The historical schema2 draft readback receipt remains unchanged after publication.
The public state is a fresh remote observation, not a rewrite of accepted history.
Pages retains the PR12 exact-SHA guard, successful deployment-job detection,
matching queued-run reuse, stale-main refusal and sync failure issue notification.
Dispatch intent additionally blocks blind redispatch after uncertain results.

## Rendering is not raw-source replay

`npm run kg:release:validate` validates receipt-bound output bytes and the rendered
semantic projection, exact active configuration and authenticated HEAD source
gitlink. It explicitly does not claim a fresh raw-source replay.
Accepted Pages builds can use the Git-tracked rendered outputs even when upstream
is unavailable. Fresh extraction always requires authenticated pinned raw Git
history and fails closed if it is unavailable. Raw upstream archives are not
mirrored into audit storage: the upstream redistribution license is unverified.

PR/push validation still materializes the source submodule at its committed
gitlink for the required real-corpus extraction regression tests, including when
an accepted receipt exists. It never advances to the upstream branch tip. This
fixture checkout does not turn the unchanged-receipt validation gate into a
fresh full-source replay; Pages rendering itself remains source-independent.

## Semantic epochs and reviewed maintenance

Production uses the explicit `ACCEPTED_SEMANTIC_GENERATOR_FILES` dependency list in
`scripts/lib/accepted-transition.mjs`. It includes news segmentation, ontology
compilation, extraction, source authentication, graph/provenance/lifecycle
construction, accepted quality-report calculations and their semantic validators. A test checks each listed module's
relative imports against this list or a documented operational exception. Adding
a new extraction dependency requires classifying and binding it explicitly.
Bindings are exact file bytes, not an attempted semantic analysis of JavaScript:
even a comment-only edit inside a listed module requires a reviewed migration.
The preview makes an unchanged graph diff visible; it never auto-approves it.

Documentation, tests, CLI wrappers, workflow orchestration, GitHub transport,
and accepted-Git loading do not independently change this
semantic hash. Their exact repository version remains pinned by `codeCommit`;
every accepted report's output bytes remain bound in the atomic release. Report
calculation fixes require review so no-op detection cannot retain stale quality
results indefinitely. D's
original offline full-history generator binding is unchanged and is not silently
relaxed by this production-only list.

The runtime axis binds the complete exact Node, V8, ICU, Unicode, locale and
timezone tuple. Even a Node patch change requires an explicit reviewed migration;
it is not automatically accepted because output records happen to be unchanged.
Pin the intended runtime for both preview and acceptance. Changing the production
runtime pin also requires its ordinary code review.

A migration review contains `schemaVersion: 1`, `kind: "semantic-migration"`, the
previous accepted release/bundle, full `from` and `to` configuration/runtime/version
axes plus their hashes, exact diff-artifact SHA-256, source commit, observed
inventory hash, source-review hash, `reviewedAt` and `reason`. The preview supplies
the bindings but never supplies approval. The builder replays the complete new
snapshot and rejects a stale predecessor, runtime, rule, source or diff binding.
The review becomes part of the candidate input identity and accepted receipt.

This supports reviewed ontology/rule/runtime changes and same-identity evidence
revisions. Ordered news IDs must remain unchanged for every previously effective
source that remains effective. Source deletion/retraction and explicit restoration
retain their separate exact source-review rules. A segmentation split, merge or
reordering fails with `news-boundary identity mapping not implemented`, even if a
semantic migration review is supplied. Reviewed **news-scoped entity assignment**
merges/splits use the same migration path; see [entity-identities.md](entity-identities.md).
Occurrence-level identity mapping remains unsupported.

Rollback reviews use `kind: "accepted-rollback"`, the current release/bundle,
the exact accepted ancestor's commit/release/bundle, `reviewedAt` and `reason`.
The rollback is a new forward release with `freshSourceReplay: false`. Target-active
paths are explicitly restored; later withdrawn paths absent from the target keep
their tombstones, and later active paths absent from the target become rollback
tombstones. Newer entity/news/assertion identities remain dormant and continue to
reference their original historical bundles. Matching target KG/news bytes never
authorize erasing the current lifecycle history.

Cross-epoch rollback is rejected. Restoring older code/configuration needs its own
explicit reviewed restoration before a compatible output rollback is possible;
the command never resets code, rewinds main or pretends to replay missing raw
sources. Referenced old audit assets must remain available under the retention
contract. All ordinary no-ops reuse the six exact accepted files and their release.

## Storage, runtime and retention budget

The pre-sync corpus at archive commit `0a0320403b76ac50fba3e81cbb6d72d655a62248`
contains 2,107 source revisions, 9,638 news revisions, 176,525 evidence rows,
108,723 extraction assertions and 166,637 supports (1,764 materialized entities).
An isolated Node 22.23.2 full build plus independent replay measured 236 seconds
and 2,724,624 KiB peak RSS. Timings depend on the runner; fixture timings are not
substitutes for this full-corpus check.

That candidate's seven audit assets total 74,486,585 bytes (about 71.04 MiB):
43,414,492 bytes compressed provenance, 5,268,307 bytes compressed lifecycle,
16,869,920 bytes KG, 8,927,003 bytes news, plus small manifests/review/diff files.
The normalized provenance expands to 196,149,416 bytes; lifecycle to 33,114,756.
Most remaining cost is the evidence/assertion/support rows and their stable hash
references, not repeated complete source documents per support. No audit ledger
or raw upstream Git history is included in the frontend bundle or Git history.

The existing hard budgets remain 64 MiB compressed provenance and 128 MiB total
candidate artifacts. Exceeding either fails closed for a reviewed partitioning or
capacity decision; evidence is never discarded to fit a budget. Every genuinely
changed accepted version retains its own bundle. No-op polls reuse the previous
version/assets, and nothing automatically deletes accepted versions or orphan
drafts. Storage permission is separate from merging implementation code. Retain
referenced bundles for historical support and rollback; retention cleanup needs
an explicit policy and authorization, never a hidden expiry assumption.

## Explicit remaining work

- Cross-epoch rollback/code restoration and news-boundary identity migrations
  remain separate; all-version rollback is not claimed
- Reviewed semantic/runtime migration and same-epoch forward restoration are
  implemented. First production acceptance, publication and matching Pages
  deployment are verified above; do not repeat bootstrap to prove them again
- Live production rollback remains unverified by those acceptance/deployment
  records. Local rollback tests are not evidence of a production rollback
- Storage and activation gates remain mandatory. Existing repository approval
  does not imply permission to expand the payload, change access or delete assets
