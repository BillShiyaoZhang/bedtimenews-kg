#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { compileOntologyFiles } from "./lib/ontology-compiler.mjs";
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) throw new Error("Usage: compile-ontology.mjs [--check]");
await compileOntologyFiles(fileURLToPath(new URL("..", import.meta.url)), { write: !args.includes("--check") });
console.log(args.includes("--check") ? "Ontology compilation is current." : "Compiled ontology and extraction rules from their declarative sources.");
