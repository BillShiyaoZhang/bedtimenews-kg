import { canonicalJson, diffRecords, sha256 } from "./candidate-bundle.mjs";

const sortedCounts = (map) => Object.fromEntries([...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, news]) => [id, news.size]));

/** Counts describe reported-category annotations, not events that happened. */
export function summarizeActionAssessments(kg) {
  const statusCounts = { applicable: 0, not_applicable: 0, undetermined: 0 };
  const classes = new Map(); const qualified = new Map();
  let unrecorded = 0;
  for (const event of kg.events) {
    const assessment = event.actionAssessment;
    if (!assessment) { unrecorded += 1; continue; }
    if (!Object.hasOwn(statusCounts, assessment.status)) throw new Error(`Unknown action assessment status: ${assessment.status}`);
    statusCounts[assessment.status] += 1;
    for (const assignment of assessment.assignments) {
      const news = classes.get(assignment.conceptId) ?? new Set(); news.add(event.newsId); classes.set(assignment.conceptId, news);
      const key = canonicalJson({ conceptId: assignment.conceptId, polarity: assignment.polarity, modality: assignment.modality });
      const qualifiedNews = qualified.get(key) ?? new Set(); qualifiedNews.add(event.newsId); qualified.set(key, qualifiedNews);
    }
  }
  return { semantics: "news_scoped_reported_descriptions_not_verified_occurrences", totalNews: kg.events.length,
    unrecordedLegacyNews: unrecorded, statusCounts, directClassNewsCounts: sortedCounts(classes), qualifiedClassNewsCounts: sortedCounts(qualified),
    independence: "not_assessed_unique_news_counts_are_not_independent_confirmations" };
}

export function actionAssessmentDiff(before, after) {
  if (!before.source?.actionExtractionVersion && !after.source?.actionExtractionVersion && ![...before.events, ...after.events].some((row) => row.actionAssessment)) return {};
  const rows = (kg) => ({ news: kg.events.map((event) => ({ id: event.newsId, assessment: event.actionAssessment ?? null })) });
  const records = diffRecords(rows(before), rows(after), { collections: ["news"] });
  return { actions: { schemaVersion: 1, before: summarizeActionAssessments(before), after: summarizeActionAssessments(after),
    records, changedNewsIds: [...new Set(["added", "removed", "changed"].flatMap((kind) => records.collections.news[kind].map((row) => row.id)))].sort(),
    assessmentsHash: sha256(canonicalJson(rows(after))),
    note: "Absent historical assessments are unrecorded, not a prior not_applicable conclusion. Qualifier-only changes remain explicit news-scoped revisions." } };
}
