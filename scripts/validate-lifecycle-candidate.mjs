#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { verifyLifecycleCandidate } from "./lib/lifecycle-run.mjs";
const directory = process.argv[2]; const args = {};
const keys = { "--source": "source", "--history-root": "historyRoot" };
if (!directory || directory.startsWith("--")) throw new Error("Usage: validate-lifecycle-candidate.mjs DIR [--source PATH] [--history-root DIR]");
for (let i = 3; i < process.argv.length; i += 2) {
  if (!keys[process.argv[i]] || !process.argv[i + 1] || process.argv[i + 1].startsWith("--") || args[keys[process.argv[i]]] !== undefined) throw new Error("Invalid lifecycle verification arguments");
  args[keys[process.argv[i]]] = process.argv[i + 1];
}
const result = await verifyLifecycleCandidate(fileURLToPath(new URL("..", import.meta.url)), directory, { ...args, onProgress: (phase) => console.error(`[lifecycle] ${phase}`) });
console.log(`Verified offline lifecycle candidate ${result.manifest.bundleId}; ${result.historyBundles} replayed historical bundle(s).`);
