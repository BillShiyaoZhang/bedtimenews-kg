#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { buildCandidate } from "./lib/candidate-run.mjs";
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--source", "--include", "--output", "--baseline", "--generated-at"].includes(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error("Usage: build-candidate.mjs [--source PATH] [--include ROOTS] [--output DIR] [--baseline DIR] [--generated-at ISO]");
  args[key === "--generated-at" ? "generatedAt" : key.slice(2)] = process.argv[i + 1];
}
const result = await buildCandidate(fileURLToPath(new URL("..", import.meta.url)), { ...args, onProgress: (phase) => console.error(`[candidate] ${phase}`) });
console.log(JSON.stringify({ kind: "offline-candidate", directory: result.outputDir, bundleId: result.manifest.bundleId, existing: result.existing, ...result.metrics }));
