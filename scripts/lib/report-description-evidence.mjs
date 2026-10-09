import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readVerifiedPages } from "./kg-build.mjs";
import { readNewsFragment } from "./news.mjs";
import { createReportDescriptionEngine } from "./report-description-extraction.mjs";

const issue = (path, message) => ({ level: "error", path, message });

/** Independent source read-back: reported descriptions are local annotations. */
export async function validateReportDescriptionEvidenceSources(kg, dataset, ontology, rules, sourceRoot, { rawPages: suppliedPages = null } = {}) {
  const issues = [];
  const enabled = [ontology.reportingForm, ontology.numericObservation, rules.reportingFormReviews, rules.numericExtraction].some((value) => value !== undefined);
  if (!enabled) {
    if (kg.source.reportDescriptionVersion || kg.events.some((event) => event.reportingFormAssessment !== undefined || event.numericObservationAssessment !== undefined)) issues.push(issue("reportDescriptions", "Description annotations require pinned contracts"));
    return issues;
  }
  const engine = createReportDescriptionEngine({ reportingForm: ontology.reportingForm, numericObservation: ontology.numericObservation, reportingFormReviews: rules.reportingFormReviews, numericExtraction: rules.numericExtraction });
  if (kg.source.reportDescriptionVersion !== "1.0.0" || kg.source.reportDescriptionNormalizationVersion !== "visible-fragment-v1") issues.push(issue("source.reportDescriptionVersion", "Unsupported report description contract"));
  const pages = new Map(dataset.pages.map((row) => [row.id, row]));
  const news = new Map(dataset.news.map((row) => [row.id, row]));
  const rawPages = suppliedPages ?? await readVerifiedPages(dataset, sourceRoot);
  const verified = new Set();
  for (const [index, event] of kg.events.entries()) {
    try {
      const item = news.get(event.newsId); const page = item && pages.get(item.pageId);
      if (!item || !page || event.sourceIds.length !== 1 || event.sourceIds[0] !== page.id) throw new Error("Description projection borrows another news/source identity");
      const raw = rawPages.get(page.id);
      if (!verified.has(page.id)) {
        if (typeof raw !== "string" || createHash("sha256").update(raw).digest("hex") !== page.contentHash) throw new Error("Description source page hash differs");
        verified.add(page.id);
      }
      const fragment = readNewsFragment(raw, item.fragment);
      const expected = engine.assess(fragment, { newsId: item.id, fragmentHash: item.fragment.contentHash });
      for (const field of ["reportingFormAssessment", "numericObservationAssessment"]) if (!isDeepStrictEqual(event[field], expected[field])) throw new Error(`${field} differs from independent exact-fragment replay`);
    } catch (error) { issues.push(issue(`events.${index}.reportDescriptions`, error.message)); }
  }
  return issues;
}
