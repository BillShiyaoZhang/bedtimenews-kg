#!/usr/bin/env node
import { validateActionEvidenceSources } from "./lib/action-evidence.mjs";
import { canonicalJson } from "./lib/candidate-bundle.mjs";

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
import { buildCandidateProvenance } from "./lib/candidate-provenance.mjs";
import { readIdentityRegistry, attachIdentityResolution } from "./lib/identity-materialization.mjs";

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
const identityRegistry = await readIdentityRegistry(projectRoot);
const needsIdentity = Boolean(identityRegistry?.identities.length || identityRegistry?.assignments.length);
const built = buildKnowledgeGraph({ dataset: newsDataset, rawPages, ontology, rules: extractionRules, generatedAt, collectTrace: needsIdentity });
const provenance = needsIdentity ? buildCandidateProvenance({ kg: built.kg, dataset: newsDataset, rawPages, trace: built.trace, sourceInventory: Object.fromEntries(newsDataset.pages.map((page) => [page.repositoryPath, page.contentHash])), bindings: { purpose: "standalone_identity_projection" } }) : null;
const kg = attachIdentityResolution({ kg: built.kg, news: newsDataset, provenance, config: identityRegistry });
const { entities, events, eventRelations } = kg;

const issues = [
  ...validate(kg, ontology),
  ...(await validateActionEvidenceSources(kg, newsDataset, extractionRules, sourceRoot, { rawPages })),
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
await writeFile(outputPath, `${canonicalJson(kg)}\n`, "utf8");
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
