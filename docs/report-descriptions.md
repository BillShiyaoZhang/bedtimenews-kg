# Reviewed reporting forms and reported numeric descriptions (H, bounded proposal)

This stage adds two independent news-scoped annotation axes. It does not
complete the broader ontology design, classify the corpus by reporting form,
verify measurements, fuse news events, or infer identities or causality.

## Declarative contracts

Ontology 2.5.0 and extraction 4.3.0 introduce a separate controlled reporting-form
vocabulary: interview, commentary and analysis. The existing entity/action/topic
hierarchies, their activation states, and legacy reporting-domain classification
are unchanged. Authored configuration remains in `ontology-source.json` and
`extraction-patterns.json`; compiler 1.2.0 emits the generated equivalents.
Historical configurations without either new axis remain readable.

`reportingFormAssessment` is reviewed-only. Without a review its state is
`undetermined`, never `not_applicable`. One explicitly timestamped review per
news identity may assign multiple active forms, each with its own exact visible
fragment evidence. Every reviewed decision, including unknown/not-applicable,
also has decision evidence and an exact fragment SHA-256 anchor. Changed text
invalidates a live review. Absent news leave the review dormant; restoration of
the same text reuses it. The initial registry is empty.

`numericObservationAssessment` is `applicable` only when at least one supported
text description is present; this never means all numeric text was parsed.
Its initial algorithm accepts only a complete standalone sentence containing an
optional literal reference period (with its explicit comma or 的 connective),
a metric from the six supported literal terms, 同比/环比, 增长/下降, and an
unsigned nonzero decimal percent magnitude. The metric literals are 工业增加值、
营业收入、全国居民消费价格、越南服装出口额、我国进出口总值 and 民间固投.
These literals are an intentionally narrow initial rule vocabulary,
not a global dictionary or a numeric-coverage claim. It does not infer a missing
year, date, place, population, denominator or entity association.

A fixed conservative ambiguity-cue inventory causes abstention for the entire
normalized visible fragment, even when a cue might concern unrelated prose.
No punctuation, ordering or paragraph break clears this exclusion. This is a
bounded heuristic with intentionally low recall, not complete understanding of
language or a promise to detect every possible paraphrase.

The parser rejects unsupported governing context, forecasts, plans, conditions,
questions, quotations/attribution, coordinated values, ranges, inequalities,
approximations, percentage points, static levels, zero, scientific notation,
Chinese-number magnitudes and malformed decimals. Commas, colons, semicolons
and newlines cannot be used to borrow an apparently unqualified suffix.
Numeric-looking rejected sentence candidates are diagnostic counts, not an
exhaustive count of real measurements or source errors.

## Evidence, identity and provenance

The existing offset-preserving `visible-fragment-v1` normalizer is reused without
changing action extraction. Each emitted observation binds exact scope, metric,
comparison, direction, scalar and unit spans; an explicit reference-period span
is optional. Coordinates are UTF-16. Decimal magnitudes stay exact canonical
strings and retain the original scalar spelling. Decreases use a direction field,
not a second signed number.

Numeric IDs have the distinct `reported-numeric-observation-` namespace and bind
news identity, exact raw fragment hash, normalization/namespace versions, occurrence
coordinates and semantic payload. Rules are separate sorted supports: duplicate
rules do not duplicate a textual occurrence. Identical text at different offsets
is separate. Corrections can change IDs; exact restoration restores the same IDs.

The ledger's existing `observations` table still means entity-extraction candidates.
New version-gated tables are `reportingFormAssessments`,
`numericObservationAssessments`, and `reportedNumericObservations`. Both known
and unknown decisions have explicit supports. Exact occurrence witnesses use
a separate evidence namespace and a hash-verified own-news input. Source
withdrawal removes only that source's contribution and preserves dormant history;
it says nothing about whether a reported statement was false.

Independent replay reconstructs the graph and ledger from authenticated raw
fragments rather than trusting stored hashes. The lifecycle requires a bijection
between rendered decisions/assignments and their axis-specific supports.
Historical omission is `unrecordedLegacyNews`, not a previous unknown or negative
assessment. Every new producer/validator is a pinned semantic dependency.

## Reader behavior

News details and the entity inspector display separate 报道形式（经审查） and
报道中的数值描述 sections. Unknown means 尚未确定; an older artifact without
this axis means 此版本未记录. Numeric details show literal metric, direction,
exact percent magnitude, comparison and literal period, plus exact clause and
span coordinates. Values are labeled reported text descriptions.

Filters are limited to reporting-form status/label and numeric status/comparison.
All numeric conditions must match the same observation. Existing keyword search
is unchanged. There are no aggregation, ranking, chart or cross-unit features.

## Acceptance boundary

This code is a semantic migration proposal. Keep current accepted files and the
receipt intact until the coherent reviewed code+data preparation flow succeeds.
Run `kg:release:migration:preview` under Node 22.23.2, en-US and UTC, inspect every
new numeric match and the complete diff, then obtain the required exact migration
and public-payload review. A local proposal never authorizes audit upload, merge,
publish or deployment. The 64 MiB compressed ledger and 128 MiB candidate limits
remain unchanged. Do not invoke legacy update/rebuild/bootstrap on state4.

The original full design was unavailable for this stage. No original-design
completeness or production validation is claimed by this document; measured
candidate results and failed/never-run checks must accompany the actual proposal.
