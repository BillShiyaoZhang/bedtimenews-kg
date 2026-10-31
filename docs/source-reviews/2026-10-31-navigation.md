# Exact navigation-source review for sync run 41201075309

This review addresses the `Candidate source review: source change requires exact
review: main/1001-1100.md` failure in
[run 41201075309](https://github.com/BillShiyaoZhang/bedtimenews-kg/actions/runs/41201075309).
It does not accept a release, advance the source gitlink, or resolve the separate
classification advisory and draft PR #41.

## Bound evidence

- Accepted main: `05d9845904ed54275260c71f9c72aaa72bca0e79`.
- Accepted bundle: `d4b1475180b67d8249f22edfd42121f73617fc9b4673af9b4c02ccd6c773501e`.
- Upstream before: `43320d5fd857bb712f4c60f9ad731df0e096d0ca`.
- Upstream after: `61b851a5d4e3eb1777f4c56eeaace834ec3bf03d`.
- [Complete upstream comparison](https://github.com/bedtimenews/bedtimenews-archive-contents/compare/43320d5fd857bb712f4c60f9ad731df0e096d0ca...61b851a5d4e3eb1777f4c56eeaace834ec3bf03d).
- Review input: [2026-10-31-navigation.json](2026-10-31-navigation.json).

The complete diff has three paths. `main.md` changes its maintenance date and
adds a link to the new directory. It is outside the fixed included roots.
`main/1001-1100.md` changes its maintenance date and adds an upstream warning
about an interruption in episodes 1076–1121. `main/1101-1200.md` is a new directory
with links to episodes 1122–1124 and commented placeholders. The two warning
texts cite different preceding episode numbers (1073/1074 versus 1074/1075);
this review does not reconcile or assert either explanation as fact. There are
no episode body files in `main/1101-1200/` in this pinned commit.

## Parsing and identity analysis

Raw blobs were read directly from the two Git commits and hashed. The accepted
and proposed `main/1001-1100.md` both return `null` from `parseSourcePage`.
The new `main/1101-1200.md` also returns `null`; neither directory contributes a
Page or News record. `main.md` likewise parses to `null` when inspected directly.
The complete proposed corpus was rebuilt with `buildNewsDataset`, the accepted
overrides and accepted `generatedAt`. Deep equality with the entire accepted
news dataset passed: all 9,694 news records and 2,086 pages, including IDs,
ordering, titles, dates, summaries, fragments and hashes, are unchanged.

The observed inventory grows from 2,116 to 2,117 files. Its canonical SHA-256
changes from `40a990591d791132a033116ce389a62c1f4458093e80ed59944b59692e2b538a`
to `98e054a901beedd14d8f8dae11187248ba30df3b396c98174afe73e93da75212`.
The JSON approves only the exact `revise` operation for the existing directory.
The new directory is a normal addition and must not receive an unused decision.
No deletion, retraction, restoration, rename or news-boundary migration is approved.

## Applying the review

Use the current accepted-release protocol, not legacy `kg:update` or a record
in `data/source-revisions.json`. After the reviewed change is authorized and
merged, an operator can supply
`source_review=docs/source-reviews/2026-10-31-navigation.json` to a **new** manual
`Sync Bedtime News archive` run. Scheduled runs do not select this file by themselves.

Before that action, verify current accepted bundle/inventory and proposed upstream
inventory still match all review bindings. Recompute and re-review if they have
changed. Independently reconcile the failed run's mutation history before deciding
whether its exact `41201075309:1` attempt may be included in `resolved_attempts`;
this document does not mark that attempt resolved. Preserve all existing journals,
Releases and artifacts. Storage/publication gates and independent replay still
apply. A local or CI pass does not demonstrate a successful production sync.

## Validation scope

Validation uses Node 22.23.2, en-US and UTC. All eight existing public audit
assets were downloaded and checked against the immutable accepted receipt's
exact SHA-256 and byte lengths. The local offline store revalidates these bytes
for every checkpoint read; it does not assert new live Release authorization.

The real-source review gate was exercised with the authenticated baseline
inventory: omission reproduces the reported failure, the exact review yields
one revision and one addition, and a subsequent byte change fails the inventory
hash binding. Source withdrawal states remain unchanged. All 17 existing source
review tests pass. Accepted output validation, lint, Worker build and Pages build
pass.

The separate coverage check fails on the unchanged accepted dataset:
`specificEventType=99.98%`, with two `other` records. They are
`news-5a74df150edd` (debt repayment pressure, PR #41) and `news-ad57b958c4b8`
(El Niño / Indonesian fires). No coverage rule or classification is changed by
this review. The active workflow treats this check as advisory; its failure must
still be reported. A successful source review is not a claim to repair coverage.

`npm test` completed its full 737-test suite: 736 passed and the single existing
coverage test failed. Because that command stops before builds on test failure,
both `npm run build` and `npm run build:pages` were separately run and passed.
The affected second coverage record comes from `reference/601-700/665.md`;
it is independent of this navigation transition and predates it.

## Accepted-checkpoint candidate result

`buildAcceptedCandidate` completed its full materialization, independent replay,
local byte readback and race checks against the real accepted Git checkpoint.
The local candidate bundle is
`40e49176cb0160f2644643e2391b7193d8236a59930205f35d7f59ee4bfa88c7`.
Its artifacts total 102,947,181 bytes (within existing limits); the build took
474,442 ms with peak RSS 4,114,204 KiB. No remote candidate staging was performed.
The full diff SHA-256 is
`04c9c48e52ebd8f62945eefdac8fc20aefd886d13260df73459aa10b9e6eac2f`.

- Classification changes only `observedInventory` and `effectiveInventory`.
- All 1,764 entities, 9,694 events, 8,141 event relations and 2,086 graph sources
  are unchanged. Graph and news additions/removals/modifications are all zero.
- Action and report-description assessment summaries and changed-news lists are
  unchanged. Content has no added, changed or restored news/entity IDs; its
  envelope and update metadata are regenerated for the new source checkpoint.
- Source revision rows have two additions (revised old directory and new
  directory) and one removal (previous directory revision).
- The changed corpus inventory rebinds 152 corpus-reconciled date derivations,
  602 `news_date_chronology` supports and 564 assertion revision rows. All 564
  assertion transitions retain identical old/new assertion content hashes.
  Removing the inventory hash from date-derivation comparisons and mapping their
  IDs through the support/revision dependencies proves all other fields equal,
  preserving ordered date inputs. These are audit derivation changes, not changed
  dates or newly verified facts.
- News and entity lifecycle transitions are empty; no withdrawal states appear.
  Historical bundle references remain intact.
- The candidate KG validates against the exact new upstream checkout, including
  all source fragments and one-to-one news projections.

The raw blobs, complete upstream diff, hash/segmentation analysis, downloaded
accepted audit, candidate, replay tools and logs are retained locally under
`work/source-review-20261031/`. Large audit artifacts are deliberately excluded
from Git. This reviewed JSON can be consumed by the existing source-review input;
no semantic migration or new acceptance receipt is fabricated in this PR.
