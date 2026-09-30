import { NEWS_DATASET_SCHEMA_VERSION, parseSourcePage, reconcileEpisodeDates, SEGMENTATION_VERSION, validateNewsDataset } from "./news.mjs";

/** The same deterministic segmentation and corpus date reconciliation for disk and historical snapshots. */
export async function buildNewsDataset({ sourceEntries, readSource, overrides, generatedAt }) {
  if (!Array.isArray(sourceEntries) || new Set(sourceEntries).size !== sourceEntries.length ||
      sourceEntries.some((path) => typeof path !== "string" || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") || !path.endsWith(".md"))) throw new Error("Invalid or duplicate news source paths");
  if (typeof readSource !== "function" || typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) throw new Error("News builder needs a reader and pinned valid generatedAt");
  const entries = [...sourceEntries].sort();
  const pages = [];
  const news = [];
  for (const repositoryPath of entries) {
    const parsed = parseSourcePage(
      repositoryPath,
      await readSource(repositoryPath),
      overrides.pages?.[repositoryPath],
    );
    if (!parsed) continue;
    pages.push(parsed.page);
    news.push(...parsed.news);
  }
  const episodeDateSummary = reconcileEpisodeDates(pages, news);

  const dataset = {
    schemaVersion: NEWS_DATASET_SCHEMA_VERSION,
    generatedAt,
    source: {
      name: "bedtimenews/bedtimenews-archive-contents",
      url: "https://github.com/bedtimenews/bedtimenews-archive-contents",
      licenseNote:
        "本数据集只保存新闻级索引、摘要、片段哈希与原文位置；完整原文保留在上游仓库。",
    },
    segmentation: {
      version: SEGMENTATION_VERSION,
      overrideVersion: overrides.version,
      mode: "deterministic-page-to-news-segmentation",
    },
    pages,
    news,
  };
  const issues = validateNewsDataset(dataset);
  if (issues.length) {
    throw new Error(
      `Processed news dataset failed validation with ${issues.length} issue(s): ` + issues.slice(0, 30).map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    );
  }
  return { dataset, episodeDateSummary };
}
