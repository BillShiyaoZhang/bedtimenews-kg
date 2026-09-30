#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { validateAcceptedReleaseFiles, validateAcceptedReleaseStructure } from "./lib/accepted-release.mjs";
import { validateNewsDataset, validateKnowledgeBaseNewsProjection } from "./lib/news.mjs";
import { createAuthenticatedGitReader } from "./lib/git-object-integrity.mjs";
import { sha256 } from "./lib/candidate-bundle.mjs";
import { validate } from "./lib/validate.mjs";
import { compileOntologyFiles } from "./lib/ontology-compiler.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parse = (value) => JSON.parse(value.toString("utf8"));
let receipt;
try { receipt = parse(await readFile(resolve(root, "data/accepted-release.json"))); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (!receipt) {
  const state = parse(await readFile(resolve(root, "data/archive-state.json")));
  if (state.schemaVersion === 4) throw new Error("State4 requires its accepted receipt; refusing legacy fallback");
  const { stdout, stderr } = await promisify(execFileCallback)(process.execPath, [resolve(root, "scripts/validate-kg.mjs")], { maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(stdout); process.stderr.write(stderr);
} else {
  validateAcceptedReleaseStructure(receipt);
  const files = new Map(await Promise.all(Object.keys(receipt.acceptedFiles).map(async (path) => [path, await readFile(resolve(root, path))])));
  validateAcceptedReleaseFiles(receipt, files);
  const git = async (args) => (await promisify(execFileCallback)("git", ["--no-replace-objects", "--literal-pathspecs", "-C", root, ...args], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    encoding: "buffer", maxBuffer: 16 * 1024 * 1024,
  })).stdout;
  const head = (await git(["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
  const reader = createAuthenticatedGitReader(async (oid) => {
    const type = (await git(["cat-file", "-t", oid])).toString("utf8").trim();
    if (!["commit", "tree"].includes(type)) throw new Error("Unexpected Git object on accepted source pointer path");
    return { type, bytes: await git(["cat-file", type, oid]) };
  });
  const sourceEntry = await reader.entry(head, receipt.source.repository.submodulePath);
  if (sourceEntry?.mode !== "160000" || sourceEntry.type !== "commit" || sourceEntry.oid !== receipt.source.commit) throw new Error("Accepted source gitlink differs from the receipt; raw checkout absence cannot excuse a mismatched pointer");
  for (const [name, binding] of Object.entries(receipt.configuration)) {
    const bindings = name === "generator" ? Object.entries(binding.files) : [[binding.path, binding.sha256]];
    for (const [path, expected] of bindings) {
      if (sha256(await readFile(resolve(root, path))) !== expected) throw new Error(`Accepted rendering configuration differs: ${path}; explicit migration is required`);
    }
  }
  await compileOntologyFiles(root);
  const kg = parse(files.get("data/generated/kg.json")); const news = parse(files.get("data/processed/news.json"));
  const ontology = parse(await readFile(resolve(root, "data/ontology.json")));
  const issues = [...validate(kg, ontology), ...validateNewsDataset(news), ...validateKnowledgeBaseNewsProjection(kg, news)];
  if (issues.length) throw new Error(`Accepted rendering invalid: ${JSON.stringify(issues.slice(0, 20))}`);
  console.log(`Accepted output bindings and rendering valid: ${receipt.releaseId}. No fresh raw-source replay was performed; fresh extraction requires the pinned upstream Git history.`);
}
