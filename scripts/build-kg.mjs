#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKnowledgeGraph, readVerifiedPages } from "./lib/kg-build.mjs";
import {
  validateKnowledgeBaseNewsProjection,
  validateNewsDataset,
} from "./lib/news.mjs";
import { validate } from "./lib/validate.mjs";
import { compileOntologyFiles } from "./lib/ontology-compiler.mjs";
import { validateTopicEvidence } from "./lib/topic-evidence.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
await compileOntologyFiles(projectRoot);
const args = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(
  args.source ??
    process.env.BEDTIMENEWS_ARCHIVE ??
    "sources/bedtimenews-archive-contents",
);
const newsPath = resolve(
  projectRoot,
  args.news ?? "data/processed/news.json",
);
const outputPath = resolve(
  projectRoot,
  args.output ?? "data/generated/kg.json",
);
const generatedAt = String(args["generated-at"] ?? new Date().toISOString());

const [ontology, extractionRules, newsDataset] = await Promise.all([
  readJson(resolve(projectRoot, "data/ontology.json")),
  readJson(resolve(projectRoot, "data/extraction-rules.json")),
  readJson(newsPath),
]);
const datasetIssues = validateNewsDataset(newsDataset);
if (datasetIssues.length) {
  throw new Error(
    `Processed news dataset is invalid:\n${datasetIssues
      .slice(0, 20)
      .map((item) => `[${item.level}] ${item.path}: ${item.message}`)
      .join("\n")}`,
  );
}

const rawPages = await readVerifiedPages(newsDataset, sourceRoot);
const { kg } = buildKnowledgeGraph({ dataset: newsDataset, rawPages, ontology, rules: extractionRules, generatedAt });
const { entities, events, eventRelations } = kg;

const issues = [
  ...validate(kg, ontology),
  ...validateKnowledgeBaseNewsProjection(kg, newsDataset),
  ...(await validateTopicEvidence(kg, newsDataset, extractionRules, sourceRoot)),
];
if (issues.length) {
  for (const issue of issues.slice(0, 30)) {
    console.error(`[${issue.level}] ${issue.path}: ${issue.message}`);
  }
  throw new Error(
    `Generated KG failed validation with ${issues.length} issue(s).`,
  );
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(kg, null, 2)}\n`, "utf8");
const coveredEvents = events.filter((event) => event.entityIds.length).length;
console.log(
  `Generated ${relative(projectRoot, outputPath)} from ${events.length} independent news ` +
    `items on ${newsDataset.pages.length} referenced pages: ${entities.length} entities, ` +
    `${eventRelations.length} relations; ${percentage(coveredEvents, events.length)}% ` +
    "of news items have semantic entities.",
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

function percentage(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}


async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
