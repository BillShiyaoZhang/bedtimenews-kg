import { canonicalJson, diffRecords, sha256 } from "./candidate-bundle.mjs";

const count = (map, key, newsId) => { const values = map.get(key) ?? new Set(); values.add(newsId); map.set(key, values); };
const counts = (map) => Object.fromEntries([...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, values]) => [key, values.size]));

/** Counts describe text annotations. They never imply factual verification. */
export function summarizeReportDescriptions(kg, provenance = null) {
  const forms = new Map(), comparisons = new Map();
  const reportingForm = { unrecordedLegacyNews: 0, statusCounts: { applicable: 0, undetermined: 0, not_applicable: 0 } };
  const numericObservation = { unrecordedLegacyNews: 0, statusCounts: { applicable: 0, undetermined: 0 }, observationCount: 0 };
  for (const event of kg.events) {
    if (!event.reportingFormAssessment) reportingForm.unrecordedLegacyNews += 1;
    else {
      const assessment = event.reportingFormAssessment;
      if (!Object.hasOwn(reportingForm.statusCounts, assessment.status)) throw new Error("Unknown reporting form status");
      reportingForm.statusCounts[assessment.status] += 1;
      for (const assignment of assessment.assignments) count(forms, assignment.conceptId, event.newsId);
    }
    if (!event.numericObservationAssessment) numericObservation.unrecordedLegacyNews += 1;
    else {
      const assessment = event.numericObservationAssessment;
      if (!Object.hasOwn(numericObservation.statusCounts, assessment.status)) throw new Error("Unknown numeric observation status");
      numericObservation.statusCounts[assessment.status] += 1;
      for (const observation of assessment.observations) { numericObservation.observationCount += 1; count(comparisons, observation.comparison, event.newsId); }
    }
  }
  reportingForm.reviewedClassNewsCounts = counts(forms);
  numericObservation.comparisonNewsCounts = counts(comparisons);
  numericObservation.coverage = "supported_templates_only_not_exhaustive_numeric_coverage";
  if (provenance?.numericObservationAssessments) {
    const rows = provenance.numericObservationAssessments;
    numericObservation.diagnostics = {
      partialCoverageNews: rows.filter((row) => row.diagnostics.partialCoverage).length,
      rejectedCandidateCount: rows.reduce((sum, row) => sum + row.diagnostics.rejectedCandidateCount, 0),
      supportedObservationCount: rows.reduce((sum, row) => sum + row.diagnostics.supportedObservationCount, 0),
    };
  }
  return { semantics: "news_scoped_reported_text_annotations_not_verified_measurements", totalNews: kg.events.length, reportingForm, numericObservation,
    independence: "not_assessed_unique_news_counts_are_not_independent_confirmations" };
}

export function reportDescriptionDiff(before, after) {
  if (!before.source?.reportDescriptionVersion && !after.source?.reportDescriptionVersion && ![...before.events, ...after.events].some((row) => row.reportingFormAssessment || row.numericObservationAssessment)) return {};
  const rows = (kg) => ({ news: kg.events.map((event) => ({ id: event.newsId, reportingFormAssessment: event.reportingFormAssessment ?? null, numericObservationAssessment: event.numericObservationAssessment ?? null })) });
  const records = diffRecords(rows(before), rows(after), { collections: ["news"] });
  return { reportDescriptions: { schemaVersion: 1, before: summarizeReportDescriptions(before), after: summarizeReportDescriptions(after), records,
    changedNewsIds: [...new Set(["added", "removed", "changed"].flatMap((kind) => records.collections.news[kind].map((row) => row.id)))].sort(),
    assessmentsHash: sha256(canonicalJson(rows(after))),
    note: "Historical absence means unrecorded. Observations are source-text descriptions, never cross-news facts or verified measurements; applicable does not mean exhaustive parsing." } };
}
