# Reviewed news-scoped entity identities

The raw graph is an extraction result. A matching name is not proof that two articles refer to the same real-world subject. The optional identity layer applies explicit reviewed decisions to individual `(newsId, rawEntityId)` assignments. It does not resolve individual textual occurrences.

## What a review changes

- Merge: point selected assignments at one stable `identity-*` ID.
- Split: point selected assignments at different stable IDs.
- Undo: set the selected assignment's `identityId` to `null`. Keep the assignment record and identity registrations.
- Retire a registration: set its status to `tombstoned` after clearing its live assignments. IDs and types cannot be removed or reused.

Unselected and future assignments retain their raw identity, even when their name or raw entity ID matches a reviewed article. Topics are excluded. A single news/raw-entity assignment cannot be split between two targets; the current normalized evidence does not distinguish repeated same-name occurrences inside that assignment. Refine mention-span extraction in a separately reviewed change before attempting that operation.

## Review input

`data/entity-identities.json` is the one hand-edited registry. It is a semantic input, separate from ontology classes and extraction triggers. Its default is deliberately empty; adding this feature does not invent or merge any identities in the real corpus.

```json
{
  "schemaVersion": 1,
  "scope": "news_scoped_extraction_assignment",
  "identities": [],
  "assignments": []
}
```

Each registration contains `id`, `type`, `label`, `status`, `reason`, and `reviewedAt`. IDs use `identity-[a-z0-9][a-z0-9-]*`; supported types are person, organization, place, facility, policy, and document. `label` is a reviewed display name, not an instruction to add global extraction aliases.

Each assignment contains:

- `id`: the existing provenance `assigned_entity` assertion ID, derived from the unchanged event ID and raw entity ID
- `newsId`, `rawEntityId`: the exact raw assignment being reviewed
- `fragmentHash`: the processed news fragment SHA-256
- `inputHash`: `buildReviewedIdentityInputHash(news)` over news ID, title, summary, and fragment hash
- `identityId`: registered target ID, or `null` for an explicit reversal
- `reason`, `reviewedAt`: substantive review rationale and an explicit valid timestamp

The module exports `assignedEntityAssertionId(eventId, rawEntityId)` and `buildReviewedIdentityInputHash(news)` to produce those anchors. Do not derive IDs by changing names. Later changes to target, input anchor, label, or registration status require a later explicit review. Source/title/summary changes fail closed until the affected assignment is re-reviewed. Inferred dates and global retention counts are excluded from the review anchor because unrelated corpus additions can change them.

## One maintenance path

Edit the registry on an ordinary code-review branch. Use the existing `kg:release:migration:preview` and single `kg:release:migration:prepare` flow in [accepted-releases.md](accepted-releases.md), review `diff.identity` together with the full candidate diff, and publish the coherent code/data PR for approval. Registry changes create a semantic epoch; normal source sync refuses them without this reviewed migration. Reversing a merge uses the same path. Same-epoch release rollback is not a shortcut for changing the registry.

Legacy update/rebuild/bootstrap refuses a nonempty registry before writing. A standalone `kg:build` can construct a fresh active projection, but cannot establish dormant historical assignments. Production and lifecycle candidates obtain that history from the independently verified predecessor bundle.

## Evidence, history, and rendering

`kg.identityResolution` contains a compact complete registry snapshot, current active/dormant assignment rows with raw support pointers, and a deterministic chronology patch. Original `entities`, `events`, `eventRelations`, and all extraction ledger tables remain unchanged. The canonical, ID-sorted registry digest in the overlay is distinct from the exact configuration file byte hash pinned by the release manifest.

The shared renderer substitutes only explicitly reviewed links, deduplicates membership within a news item, and counts unique news. Two raw assignments mapped to one target retain both original assertion IDs and all their support IDs. This is not a claim of independent corroboration or cross-news fact fusion. Derived chronology is rebuilt from resolved membership, including adjacency and 90-place/250-other mention caps, and is labeled as reviewed-news-identity date order. News dates are not asserted occurrence dates.

Browse/search/graph views consume this resolved projection. Old raw-entity links present the reviewed destinations explicitly; a split never silently redirects to one arbitrarily chosen subject. Reviewed targets and news indicate their review scope. Raw IDs and exact evidence remain addressable in that accepted version's audit bundle.

A source withdrawal or loss of global retention can make a previously verified assignment dormant. It keeps its decision, registration, and last-active bundle-scoped evidence references. Restoring the exact supported input reactivates it. Unknown missing assignments cannot fabricate dormant history. The optional identity lifecycle section records immediate changes separately from raw extraction assertion transitions. Rendering-only checks verify current registry/graph/chronology consistency; only accepted-candidate replay establishes historical validity.

## Acceptance checks and current limits

Tests cover explicit merges/splits/clear/restoration; homonyms and future news; source withdrawal and 2→1 retention; duplicate/missing/cross-type/topic targets; changed title/summary/fragment anchors; ID reuse and later-review requirements; chronology middle insertions, equal/unknown dates and cap crossings; old receipts without an identity axis; reviewed migration and later source continuation; and corrupted overlay/support/chronology data. Empty registry output remains byte-equivalent to the legacy graph.

This layer does not implement occurrence-level disambiguation, news segmentation split/merge mapping, cross-epoch code restoration, semantic fact fusion. Evidence-backed reported-action annotations are described separately in [action-assessments.md](action-assessments.md). Those capabilities must not be inferred from an identity label or support count.
