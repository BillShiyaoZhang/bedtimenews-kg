#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { buildLifecycleCandidate } from "./lib/lifecycle-run.mjs";
const args = {};
const keys = { "--source": "source", "--include": "include", "--output": "output", "--baseline": "baseline", "--source-review": "sourceReview", "--history-root": "historyRoot", "--generated-at": "generatedAt" };
for (let i = 2; i < process.argv.length; i += 2) {
  if (!keys[process.argv[i]] || !process.argv[i + 1] || process.argv[i + 1].startsWith("--") || args[keys[process.argv[i]]] !== undefined) throw new Error("Usage: build-lifecycle-candidate.mjs [--source PATH] [--history-root DIR] [--output DIR] [--baseline DIR --source-review FILE] [--generated-at ISO]");
  args[keys[process.argv[i]]] = process.argv[i + 1];
}
const result = await buildLifecycleCandidate(fileURLToPath(new URL("..", import.meta.url)), { ...args, onProgress: (phase) => console.error(`[lifecycle] ${phase}`) });
console.log(JSON.stringify({ kind: "offline-lifecycle-candidate", directory: result.outputDir, bundleId: result.manifest.bundleId, existing: result.existing, ...result.metrics }));
