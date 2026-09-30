#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSegmentationReport } from "./lib/news.mjs";
import { buildNewsDataset } from "./lib/news-build.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(
  args.source ??
    process.env.BEDTIMENEWS_ARCHIVE ??
    "sources/bedtimenews-archive-contents",
);
const outputPath = resolve(
  projectRoot,
  args.output ?? "data/processed/news.json",
);
const reportPath = args.report
  ? resolve(projectRoot, args.report)
  : args.output
    ? null
    : resolve(projectRoot, "data/review/news-segmentation.json");
const overridesPath = resolve(
  projectRoot,
  args.overrides ?? "data/news-overrides.json",
);
const includeRoots = String(
  args.include ??
    "main,daily,reference,opinion,business,commercial,livestream,shorts",
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const limit = Number(args.limit ?? 0);
const generatedAt = String(args["generated-at"] ?? new Date().toISOString());
const overrides = await readJson(overridesPath);
const markdownFiles = (
  await Promise.all(
    includeRoots.map((folder) => walk(resolve(sourceRoot, folder))),
  )
)
  .flat()
  .filter((path) => extname(path) === ".md")
  .sort()
  .slice(0, limit || undefined);

if (!markdownFiles.length) {
  throw new Error(
    `No Markdown files found under ${sourceRoot}. ` +
      "Pass --source /path/to/bedtimenews-archive-contents.",
  );
}

const { dataset, episodeDateSummary } = await buildNewsDataset({
  sourceEntries: markdownFiles.map((filePath) => relative(sourceRoot, filePath).replaceAll("\\", "/")),
  readSource: (repositoryPath) => readFile(resolve(sourceRoot, repositoryPath), "utf8"),
  overrides, generatedAt,
});
const { pages, news } = dataset;

await writeJson(outputPath, dataset);
if (reportPath) {
  await writeJson(reportPath, buildSegmentationReport(dataset));
}
const multiNewsPages = pages.filter(
  (page) => page.segmentation.newsCount > 1,
).length;
const reviewPages = pages.filter(
  (page) => page.segmentation.needsReview,
).length;
console.log(
  `Generated ${relative(projectRoot, outputPath)}: ${news.length} independent news ` +
    `items from ${pages.length} referenced pages; ${multiNewsPages} pages were split, ` +
    `${reviewPages} page(s) require segmentation review; ` +
    `${episodeDateSummary.adjustedPages}/${episodeDateSummary.episodePages} episode dates ` +
    `were reconciled against title sequence.`,
);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) parsed[key] = inlineValue;
    else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[key] = values[++index];
    } else parsed[key] = true;
  }
  return parsed;
}

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      }),
  );
  return nested.flat();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
