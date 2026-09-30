#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { verifyCandidate } from "./lib/candidate-run.mjs";
const directory = process.argv[2];
if (!directory || directory.startsWith("--")) throw new Error("Usage: validate-candidate.mjs CANDIDATE [--source PATH] [--baseline DIR]");
const options = {};
for (let i = 3; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--source", "--baseline"].includes(key) || !process.argv[i + 1]) throw new Error("Unsupported validation argument");
  options[key.slice(2)] = process.argv[i + 1];
}
const started = performance.now();
const result = await verifyCandidate(fileURLToPath(new URL("..", import.meta.url)), directory, options);
console.log(`Verified offline candidate ${result.manifest.bundleId}; accepted data was not modified.`);
console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - started), maxRssKiB: process.resourceUsage().maxRSS }));
