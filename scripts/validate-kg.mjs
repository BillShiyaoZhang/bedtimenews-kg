#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateKnowledgeBaseNewsProjection,
  validateNewsDataset,
} from "./lib/news.mjs";
import { validate } from "./lib/validate.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const kgPath = resolve(root, process.argv[2] ?? "data/generated/kg.json");
const ontologyPath = resolve(root, process.argv[3] ?? "data/ontology.json");
const newsPath = resolve(root, process.argv[4] ?? "data/processed/news.json");
const [kg, ontology, newsDataset] = await Promise.all([
  readJson(kgPath),
  readJson(ontologyPath),
  readJson(newsPath),
]);
const issues = [
  ...validateNewsDataset(newsDataset),
  ...validate(kg, ontology),
  ...validateKnowledgeBaseNewsProjection(kg, newsDataset),
];

if (issues.length) {
  for (const issue of issues) {
    console.error(`[${issue.level}] ${issue.path}: ${issue.message}`);
  }
  console.error(`\nKG validation failed with ${issues.length} issue(s).`);
  process.exitCode = 1;
} else {
  console.log(
    `KG valid: ${kg.entities.length} entities, ${kg.events.length} events, ` +
      `${kg.eventRelations.length + kg.entityRelations.length} relations, ` +
      `${kg.sources.length} referenced pages; every event projects exactly one processed news item.`,
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
