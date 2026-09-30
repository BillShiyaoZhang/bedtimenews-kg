import { createHash } from "node:crypto";
import { readVerifiedPages } from "./kg-build.mjs";
import { readNewsFragment } from "./news.mjs";
import { createActionExtractionEngine } from "./action-extraction.mjs";

const issue = (path, message) => ({ level: "error", path, message });

/** Reassess only each projection's own hash-verified news fragment. */
export async function validateActionEvidenceSources(kg, dataset, rules, sourceRoot, { rawPages: suppliedPages = null } = {}) {
  const issues = [];
  if (!rules.actionExtraction) {
    if (kg.source.actionExtractionVersion || kg.events.some((event) => event.actionAssessment !== undefined)) issues.push(issue("actionAssessment", "Action annotations cannot exist without a pinned extraction contract"));
    return issues;
  }
  if (kg.source.actionExtractionVersion !== rules.actionExtraction.version || kg.source.actionNormalizationVersion !== rules.actionExtraction.normalizationVersion) {
    issues.push(issue("source.actionExtractionVersion", "Action extraction/normalization version differs from the pinned rules"));
  }
  const engine = createActionExtractionEngine(rules.actionExtraction);
  const pages = new Map(dataset.pages.map((row) => [row.id, row]));
  const news = new Map(dataset.news.map((row) => [row.id, row]));
  const rawPages = suppliedPages ?? await readVerifiedPages(dataset, sourceRoot);
  const verified = new Set();
  for (const [index, event] of kg.events.entries()) {
    try {
      const item = news.get(event.newsId); const page = item && pages.get(item.pageId);
      if (!item || !page || event.sourceIds.length !== 1 || event.sourceIds[0] !== page.id) throw new Error("Action projection borrows another news/source identity");
      const raw = rawPages.get(page.id);
      if (!verified.has(page.id)) {
        if (typeof raw !== "string" || createHash("sha256").update(raw).digest("hex") !== page.contentHash) throw new Error("Action source page hash differs");
        verified.add(page.id);
      }
      const fragment = readNewsFragment(raw, item.fragment);
      for (const error of engine.validate(event.actionAssessment, fragment, { newsId: item.id, fragmentHash: item.fragment.contentHash })) issues.push(issue(`events.${index}.actionAssessment`, error.message));
    } catch (error) { issues.push(issue(`events.${index}.actionAssessment`, error.message)); }
  }
  return issues;
}
