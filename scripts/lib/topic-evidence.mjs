import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createExtractionEngine } from "./extraction.mjs";
import { readNewsFragment } from "./news.mjs";
import { validateTopicEvidenceStructure } from "../../app/lib/topic-evidence.mjs";

// newsId already resolves to the exact source page, range and SHA-256 in the
// processed dataset. Do not duplicate full text or mutable page-wide evidence.
export async function validateTopicEvidence(kg, dataset, rules, sourceRoot) {
  const issues = validateTopicEvidenceStructure(kg);
  const extractor = createExtractionEngine(rules);
  if (kg.source?.extractionVersion !== rules.version) {
    issues.push(error("source.extractionVersion", "KG and extraction-rules versions differ; run an explicit kg:rebuild"));
  }
  const newsById = new Map(dataset.news.map((item) => [item.id, item]));
  const pages = new Map(dataset.pages.map((page) => [page.id, page]));
  const rawPages = new Map();
  const topicById = new Map(rules.topics.map((topic) => [topic.entityId, topic]));
  for (const [index, entity] of kg.entities.entries()) {
    if (entity.type !== "topic") continue;
    const topic = topicById.get(entity.id);
    const aliases = topic?.aliases.filter((alias) => alias !== topic.label);
    if (!topic || entity.label !== topic.label || JSON.stringify(entity.aliases) !== JSON.stringify(aliases)) {
      issues.push(error(`entities.${index}.aliases`, "Topic aliases must exactly match the reviewed names in extraction-rules"));
    }
  }
  for (const [index, event] of kg.events.entries()) {
    const path = `events.${index}.topicEvidence`;
    const item = newsById.get(event.newsId);
    const page = item && pages.get(item.pageId);
    if (!page || event.sourceIds?.length !== 1 || event.sourceIds[0] !== page.id) {
      issues.push(error(path, "Topic evidence must resolve through this event's own news fragment"));
      continue;
    }
    try {
      if (!rawPages.has(page.id)) {
        rawPages.set(page.id, await readFile(resolve(sourceRoot, page.repositoryPath), "utf8"));
      }
      // readNewsFragment verifies the content hash before any term is accepted.
      const fragment = readNewsFragment(rawPages.get(page.id), item.fragment);
      const expected = extractor.matchTopicEvidence(fragment);
      if (JSON.stringify(event.topicEvidence) !== JSON.stringify(expected)) {
        issues.push(error(path, "Topic evidence differs from the exact trigger matches in its verified news fragment"));
      }
    } catch (cause) {
      issues.push(error(path, cause.message));
    }
  }
  return issues;
}

function error(path, message) {
  return { level: "error", path, message };
}
