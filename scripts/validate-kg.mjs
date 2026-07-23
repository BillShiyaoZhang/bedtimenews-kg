#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./lib/validate.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const kgPath = resolve(root, process.argv[2] ?? "data/kg.json");
const ontologyPath = resolve(root, process.argv[3] ?? "data/ontology.json");
const [kg, ontology] = await Promise.all([
  readJson(kgPath),
  readJson(ontologyPath),
]);
const issues = validate(kg, ontology);

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
      `${kg.sources.length} sources.`,
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
