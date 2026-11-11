# Conservative publication dates

Segmentation 1.5.0 no longer invents a publication date from archive import or
maintenance timestamps, dates mentioned in an individual news item, or the
spacing between numbered episodes. `dateCreated` (preferred over `date`) remains
an archive observation in `dateProvenance.observedAt`, not publication evidence.

Direct publication witnesses are a dated repository filename, an explicit
program opening, or a dated page title. Visible formatting is normalized before
reading an opening; HTML comments remain excluded. Conflicting direct witnesses,
impossible calendar dates, and explicit weekday mismatches require review rather
than silently correcting a digit. An inversion between otherwise valid numbered
episode observations quarantines both sides: sequence order alone cannot decide
which original observation was wrong.

Unknown publication dates retain the existing `1900-01-01` storage sentinel with
`datePrecision: "unknown"`. They display as 日期未知 and cannot enter reliable
chronology. A genuine observed January 1 has day precision. Full source hashes,
original observed values, conflict reasons and conflicting paths remain bound to
candidate provenance; sequence-derived uncertainty additionally binds the corpus
inventory. No raw source, failed attempt, historical revision or audit evidence is
removed by this change.

Changing a date observation or learning an independently reviewed publication date
requires the normal exact-source/migration review and replay. The parser does not
silently hardcode external guesses for a particular episode.
