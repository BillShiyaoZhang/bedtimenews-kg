import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, lstat, realpath, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256, diffKnowledgeGraphs, diffRecords, publishCandidateBundle, verifyCandidateBundle } from "./candidate-bundle.mjs";
import { compileOntology } from "./ontology-compiler.mjs";
import { classifyArchiveChanges } from "./incremental.mjs";
import { canonicalDataset, buildKnowledgeGraph, readVerifiedPages } from "./kg-build.mjs";
import { buildCandidateProvenance, validateCandidateProvenance } from "./candidate-provenance.mjs";
import { validateNewsDataset, validateNewsFragments, validateKnowledgeBaseNewsProjection } from "./news.mjs";
import { validateTopicEvidence } from "./topic-evidence.mjs";
import { validate } from "./validate.mjs";

const execFile = promisify(execFileCallback);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
export const CANDIDATE_STORAGE_BUDGET = Object.freeze({ maxLedgerCompressedBytes: 64 * 1024 * 1024, maxTotalArtifactBytes: 128 * 1024 * 1024 });
const artifactNames = ["diff.json", "kg.json", "news.json", "provenance.json.gz"];
const configPaths = {
  ontologySource: "data/ontology-source.json", ontology: "data/ontology.json",
  patterns: "data/extraction-patterns.json", rules: "data/extraction-rules.json",
  newsOverrides: "data/news-overrides.json", compiler: "scripts/lib/ontology-compiler.mjs",
  segmentation: "scripts/lib/news.mjs", acceptedState: "data/archive-state.json",
  acceptedKG: "data/generated/kg.json", acceptedNews: "data/processed/news.json",
};
const must = (value, message) => { if (!value) throw new Error(message); };

export function assertCandidateBudget(manifest) {
  const artifacts = manifest.artifacts;
  must(artifacts["provenance.json.gz"]?.bytes <= CANDIDATE_STORAGE_BUDGET.maxLedgerCompressedBytes, "Compressed candidate ledger exceeds 64 MiB budget; review partitioning/retention before continuing");
  must(Object.values(artifacts).reduce((sum, item) => sum + item.bytes, 0) <= CANDIDATE_STORAGE_BUDGET.maxTotalArtifactBytes, "Candidate artifacts exceed 128 MiB budget");
}

export async function sourceInventory(sourceRoot, roots, { allowEmpty = false } = {}) {
  must(await realpath(sourceRoot) === resolve(sourceRoot), "Candidate source root or ancestor is a symlink; use the canonical source directory");
  const files = [];
  async function walk(path) {
    const stat = await lstat(path);
    must(!stat.isSymbolicLink(), `Candidate source symlink is unsupported: ${path}`);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).filter((name) => !name.startsWith(".")).sort()) await walk(resolve(path, entry));
    } else if (stat.isFile() && extname(path) === ".md") files.push(path);
  }
  for (const root of roots) {
    must(/^[a-z][a-z0-9_-]*$/u.test(root), `Invalid included root: ${root}`);
    try { await walk(resolve(sourceRoot, root)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  must(files.length || allowEmpty, "No Markdown source files found");
  const entries = [];
  for (const path of files.sort()) entries.push([relative(sourceRoot, path).split(sep).join("/"), sha256(await readFile(path))]);
  return Object.fromEntries(entries);
}

export function assertSafeCandidateSources(accepted, current) {
  const changes = classifyArchiveChanges(accepted, current);
  must(!changes.modified.length && !changes.deleted.length && !changes.possibleRenames.length && !changes.duplicateAdditions.length,
    `Candidate source changes require an implemented withdrawal/review migration: modified=${changes.modified.length}, deleted=${changes.deleted.length}, renamed=${changes.possibleRenames.length}, duplicate=${changes.duplicateAdditions.length}. Existing preserve_news reviews must first pass the accepted updater.`);
  const newHashes = new Set();
  for (const path of changes.added) {
    must(!newHashes.has(current[path]), `Duplicate additions in candidate source inventory: ${path}`);
    newHashes.add(current[path]);
  }
  return changes;
}

export function assertCandidateOutput(root, output, sourceRoot, baseline) {
  const target = resolve(output);
  const project = resolve(root);
  if (target === project || target.startsWith(`${project}${sep}`)) must(target.startsWith(`${resolve(root, "work")}${sep}`), "In-repository candidates must be inside ignored work/; never public or build output");
  must(!project.startsWith(`${target}${sep}`), "Candidate output must not contain the repository");
  const overlaps = (a, b) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
  for (const path of ["data", "app", "scripts", "tests", "docs", ".git", ".github", "sources", "node_modules"]) must(!overlaps(target, resolve(root, path)), "Candidate output must not overlap accepted data, source or repository code");
  must(!overlaps(target, sourceRoot), "Candidate output must not overlap the source archive");
  if (baseline) must(!overlaps(target, resolve(baseline)), "Candidate output must not overlap its baseline bundle");
}

async function generatorBindings(root) {
  const files = ["scripts/build-news.mjs", "scripts/build-kg.mjs", "scripts/build-candidate.mjs", "scripts/validate-candidate.mjs", "scripts/compile-ontology.mjs", "scripts/build-lifecycle-candidate.mjs", "scripts/validate-lifecycle-candidate.mjs", "app/lib/topic-evidence.mjs", "app/lib/ontology-hierarchy.mjs"];
  for (const file of (await readdir(resolve(root, "scripts/lib"))).filter((name) => name.endsWith(".mjs")).sort()) files.push(`scripts/lib/${file}`);
  const hashes = {};
  for (const path of files.sort()) hashes[path] = sha256(await readFile(resolve(root, path)));
  return { sha256: sha256(canonicalJson(hashes)), files: hashes };
}

export async function activeSnapshot(root) {
  const inputs = {}; const bytes = {};
  for (const [name, path] of Object.entries(configPaths)) {
    const content = await readFile(resolve(root, path));
    bytes[name] = content;
    inputs[name] = { path, sha256: sha256(content) };
  }
  inputs.generator = await generatorBindings(root);
  return { inputs, bytes, json: (name) => JSON.parse(bytes[name].toString("utf8")) };
}

export function candidateRuntimeBinding() {
  const locale = new Intl.DateTimeFormat().resolvedOptions();
  const runtime = { node: process.versions.node, icu: process.versions.icu, unicode: process.versions.unicode, v8: process.versions.v8, locale: locale.locale, timeZone: locale.timeZone };
  return { ...runtime, sha256: sha256(canonicalJson(runtime)) };
}

export async function captureInputs(root, inventory, recipe, baselineManifest, snapshot) {
  must(!Object.hasOwn(recipe, "sha256"), "Recipe payload must not contain a precomputed hash");
  const inputs = { ...(snapshot ?? await activeSnapshot(root)).inputs };
  inputs.sourceInventory = { sha256: sha256(canonicalJson(inventory)), fileCount: Object.keys(inventory).length };
  inputs.recipe = { ...recipe, sha256: sha256(canonicalJson(recipe)) };
  inputs.runtime = candidateRuntimeBinding();
  if (baselineManifest) inputs.baselineCandidate = { sha256: sha256(canonicalJson(baselineManifest)), bundleId: baselineManifest.bundleId };
  return inputs;
}

export async function assertBaselineUnchanged(root, path, manifest) {
  if (!path) return;
  const directory = resolve(root, path);
  const directoryStat = await lstat(directory);
  must(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && await realpath(directory) === directory, "Baseline directory or ancestor became unsafe");
  async function readRegular(file) {
    const stat = await lstat(file);
    must(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Baseline file type changed during candidate operation");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      must(opened.isFile() && opened.nlink === 1 && opened.ino === stat.ino && opened.dev === stat.dev, "Baseline file changed while opening");
      const bytes = await handle.readFile();
      const after = await lstat(file);
      must(after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && after.ino === opened.ino && after.dev === opened.dev, "Baseline file changed while reading");
      return bytes;
    } finally { await handle.close(); }
  }
  const manifestPath = resolve(directory, "manifest.json");
  must((await readRegular(manifestPath)).toString("utf8") === `${canonicalJson(manifest)}\n`, "Baseline manifest changed during candidate build");
  const names = [...Object.keys(manifest.artifacts), "manifest.json"].sort();
  must(canonicalJson((await readdir(directory)).sort()) === canonicalJson(names), "Baseline artifacts changed during candidate build");
  for (const [name, binding] of Object.entries(manifest.artifacts)) {
    const content = await readRegular(resolve(directory, name));
    must(content.length === binding.bytes && sha256(content) === binding.sha256, "Baseline artifact changed during candidate build");
  }
  const after = await lstat(directory);
  must(after.isDirectory() && !after.isSymbolicLink() && after.ino === directoryStat.ino && after.dev === directoryStat.dev && await realpath(directory) === directory, "Baseline directory changed during candidate operation");
  must((await readRegular(manifestPath)).toString("utf8") === `${canonicalJson(manifest)}\n`, "Baseline manifest changed during candidate operation");
}

async function regenerateNews(root, sourceRoot, recipe) {
  const temporary = await mkdtemp(resolve(tmpdir(), "kg-candidate-news-"));
  try {
    const output = resolve(temporary, "news.json");
    await execFile(process.execPath, [resolve(root, "scripts/build-news.mjs"), "--source", sourceRoot, "--include", recipe.includedRoots.join(","), "--generated-at", recipe.generatedAt, "--output", output], { cwd: root, maxBuffer: 1024 * 1024 });
    return canonicalDataset(await readJson(output));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function provenanceBindings(inputs) {
  return { segmentationHash: inputs.segmentation.sha256, overridesHash: inputs.newsOverrides.sha256, ontologyHash: inputs.ontology.sha256, rulesHash: inputs.rules.sha256, generatorHash: inputs.generator.sha256 };
}

async function validateArtifacts({ artifacts, expectedDataset, inventory, rawPages, ontology, rules, sourceRoot, bindings, expectedDiff }) {
  const issues = [];
  if (Object.keys(artifacts).sort().join(",") !== artifactNames.join(",")) throw new Error("Incomplete candidate artifacts");
  const dataset = artifacts["news.json"];
  const kg = artifacts["kg.json"];
  must(kg.generatedAt === expectedDataset.generatedAt, "KG timestamp differs from the pinned source recipe");
  must(canonicalJson(dataset) === canonicalJson(expectedDataset), "Candidate news differs from resegmented source");
  issues.push(...validateNewsDataset(dataset), ...validate(kg, ontology), ...validateKnowledgeBaseNewsProjection(kg, dataset));
  issues.push(...await validateNewsFragments(dataset, sourceRoot), ...await validateTopicEvidence(kg, dataset, rules, sourceRoot));
  if (issues.length) throw new Error(issues.slice(0, 15).map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  const provenanceIssues = validateCandidateProvenance(artifacts["provenance.json.gz"], { kg, dataset, rawPages, ontology, rules, sourceInventory: inventory, bindings });
  if (provenanceIssues.length) throw new Error(provenanceIssues.map((issue) => issue.message).join("\n"));
  must(canonicalJson(artifacts["diff.json"]) === canonicalJson(expectedDiff), "Candidate diff differs from its baseline");
  return [];
}

export function candidateDiff(baseline, artifacts) {
  const provenance = artifacts["provenance.json.gz"];
  return { schemaVersion: "1.0.0", epistemicScope: "extraction_assignment", graph: diffKnowledgeGraphs(baseline.kg, artifacts["kg.json"]), news: diffRecords(baseline.news, artifacts["news.json"], { collections: ["pages", "news"] }), provenance: baseline.provenance ? { available: true, diff: diffRecords(baseline.provenance, provenance, { collections: ["sourceRevisions", "newsRevisions", "observations", "retention", "classifications", "assertions", "supports", "assertionRevisions"] }) } : { available: false, reason: "Accepted KG has no derivation ledger; initial support recording is not newly discovered knowledge" } };
}

async function baselineData(root, baselinePath, snapshot) {
  if (!baselinePath) return { kg: snapshot.json("acceptedKG"), news: snapshot.json("acceptedNews") };
  const bundle = await verifyCandidateBundle(resolve(root, baselinePath));
  must(Object.keys(bundle.artifacts).sort().join(",") === artifactNames.join(","), "Baseline candidate is incomplete");
  return { kg: bundle.artifacts["kg.json"], news: bundle.artifacts["news.json"], provenance: bundle.artifacts["provenance.json.gz"], manifest: bundle.manifest };
}

async function prepare(root, options, hooks = {}) {
  const sourceRoot = resolve(root, options.source ?? "sources/bedtimenews-archive-contents");
  const snapshot = await activeSnapshot(root);
  await hooks.afterInputSnapshot?.();
  const { ontology, rules } = compileOntology(snapshot.json("ontologySource"), snapshot.json("patterns"));
  must(snapshot.bytes.ontology.toString("utf8") === `${JSON.stringify(ontology, null, 2)}\n` && snapshot.bytes.rules.toString("utf8") === `${JSON.stringify(rules, null, 2)}\n`, "Compiled ontology/rules are stale or hand-edited");
  const state = snapshot.json("acceptedState");
  const includedRoots = options.include ? String(options.include).split(",") : state.includedRoots;
  must(new Set(includedRoots).size === includedRoots.length && canonicalJson([...includedRoots].sort()) === canonicalJson([...state.includedRoots].sort()), "Candidate scope differs from accepted archive roots");
  const inventory = await sourceInventory(sourceRoot, includedRoots);
  assertSafeCandidateSources(state.acceptedFiles, inventory);
  const { stdout: commit } = await execFile("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
  const generatedAt = options.generatedAt ?? (await execFile("git", ["-C", sourceRoot, "show", "-s", "--format=%cI", "HEAD"])).stdout.trim();
  must(typeof generatedAt === "string" && /^\d{4}-\d\d-\d\dT/u.test(generatedAt) && Number.isFinite(Date.parse(generatedAt)), "An explicit valid generatedAt is required");
  const recipe = { includedRoots: [...includedRoots].sort(), archiveCommit: commit.trim(), generatedAt, storageBudget: CANDIDATE_STORAGE_BUDGET };
  const baseline = await baselineData(root, options.baseline, snapshot);
  must(validateKnowledgeBaseNewsProjection(baseline.kg, baseline.news).length === 0, "Baseline news/KG projection is inconsistent");
  const inputs = await captureInputs(root, inventory, recipe, baseline.manifest, snapshot);
  const dataset = await regenerateNews(root, sourceRoot, recipe);
  await hooks.afterNewsRegeneration?.();
  const rawPages = await readVerifiedPages(dataset, sourceRoot);
  const bindings = provenanceBindings(inputs);
  const preparedInventory = await sourceInventory(sourceRoot, includedRoots);
  must(canonicalJson(preparedInventory) === canonicalJson(inventory), "Source inventory changed during candidate preparation");
  must(canonicalJson(await captureInputs(root, preparedInventory, recipe, baseline.manifest)) === canonicalJson(inputs), "Candidate inputs changed during preparation");
  await assertBaselineUnchanged(root, options.baseline, baseline.manifest);
  return { sourceRoot, ontology, rules, state, inventory, recipe, baseline, inputs, dataset, rawPages, bindings };
}

export function candidateVersions({ ontology, rules, dataset }) {
  return { candidate: "1.0.0", ontology: ontology.version, extraction: rules.version, news: dataset.schemaVersion, segmentation: dataset.segmentation.version, overrides: dataset.segmentation.overrideVersion, compiler: ontology.compilation.compilerVersion, node: process.versions.node, icu: process.versions.icu };
}

export async function buildCandidate(root, options = {}, hooks = {}) {
  must(Object.keys(hooks).every((name) => ["afterInputSnapshot", "afterNewsRegeneration", "beforeVerifyReturn"].includes(name) && typeof hooks[name] === "function"), "Invalid candidate preparation test hook");
  const start = performance.now();
  const report = options.onProgress ?? (() => {});
  report("verify source/configuration and regenerate news");
  const context = await prepare(root, options, hooks);
  const { dataset, rawPages, ontology, rules, recipe, inventory, bindings, baseline, inputs, sourceRoot } = context;
  report("materialize graph and normalized support ledger");
  const built = buildKnowledgeGraph({ dataset, rawPages, ontology, rules, generatedAt: recipe.generatedAt, collectTrace: true });
  const kg = built.kg;
  const provenance = buildCandidateProvenance({ kg, dataset, sourceInventory: inventory, rawPages, trace: built.trace, bindings });
  built.trace = null;
  const artifacts = { "news.json": dataset, "kg.json": kg, "provenance.json.gz": provenance };
  const diff = candidateDiff(baseline, artifacts);
  artifacts["diff.json"] = diff;
  const output = resolve(root, options.output ?? `work/candidates/${sha256(canonicalJson(inputs)).slice(0, 20)}`);
  assertCandidateOutput(root, output, sourceRoot, options.baseline);
  const versions = candidateVersions({ ontology, rules, dataset });
  // Revalidate complete inputs and replay actual derivations before exposing a bundle.
  report("encode offline bundle and replay validation");
  let verifiedBundleId = null;
  const result = await publishCandidateBundle(output, { artifacts, inputs, versions, validate: async ({ artifacts: actual, inputs: pinned, manifest }) => {
    await assertBaselineUnchanged(root, options.baseline, baseline.manifest);
    assertCandidateBudget(manifest);
    must(canonicalJson(manifest.versions) === canonicalJson(versions), "Candidate manifest version labels differ from the active recipe");
    const current = await sourceInventory(sourceRoot, recipe.includedRoots);
    must(canonicalJson(current) === canonicalJson(inventory), "Source inventory changed during candidate build");
    must(canonicalJson(await captureInputs(root, current, recipe, baseline.manifest)) === canonicalJson(pinned), "Candidate recipe/configuration/accepted baseline changed during build");
    if (verifiedBundleId === manifest.bundleId) { report("readback hashes match the semantically verified bundle"); return []; }
    report("replay graph and every normalized derivation");
    await validateArtifacts({ artifacts: actual, expectedDataset: dataset, inventory, rawPages, ontology, rules, sourceRoot, bindings, expectedDiff: diff });
    verifiedBundleId = manifest.bundleId;
    report("semantic replay passed; stage and verify exact artifact bytes");
    return [];
  } });
  return { ...result, metrics: { elapsedMs: Math.round(performance.now() - start), maxRssKiB: process.resourceUsage().maxRSS, news: kg.events.length, entities: kg.entities.length, assertions: provenance.assertions.length, supports: provenance.supports.length, evidence: provenance.evidence.length, artifactBytes: Object.values(result.manifest.artifacts).reduce((sum, item) => sum + item.bytes, 0) } };
}

export async function verifyCandidate(root, directory, options = {}, hooks = {}) {
  must(Object.keys(hooks).every((name) => ["afterInputSnapshot", "afterNewsRegeneration", "beforeVerifyReturn"].includes(name) && typeof hooks[name] === "function"), "Invalid candidate verification test hook");
  const bundle = await verifyCandidateBundle(resolve(root, directory));
  assertCandidateBudget(bundle.manifest);
  const recipe = bundle.manifest.inputs.recipe;
  must(recipe && Array.isArray(recipe.includedRoots), "Candidate manifest has no source recipe");
  const context = await prepare(root, { ...options, include: recipe.includedRoots.join(","), generatedAt: recipe.generatedAt }, hooks);
  must(canonicalJson(candidateVersions(context)) === canonicalJson(bundle.manifest.versions), "Candidate manifest version labels differ from the active recipe");
  must(canonicalJson(context.inputs) === canonicalJson(bundle.manifest.inputs), "Current pinned recipe/configuration/accepted baseline differs from candidate");
  const expectedDiff = candidateDiff(context.baseline, bundle.artifacts);
  await validateArtifacts({ artifacts: bundle.artifacts, expectedDataset: context.dataset, inventory: context.inventory, rawPages: context.rawPages, ontology: context.ontology, rules: context.rules, sourceRoot: context.sourceRoot, bindings: context.bindings, expectedDiff });
  await hooks.beforeVerifyReturn?.();
  const finalInventory = await sourceInventory(context.sourceRoot, context.recipe.includedRoots);
  must(canonicalJson(finalInventory) === canonicalJson(context.inventory), "Source inventory changed during candidate verification");
  must(canonicalJson(await captureInputs(root, finalInventory, context.recipe, context.baseline.manifest)) === canonicalJson(bundle.manifest.inputs), "Candidate inputs changed during verification");
  await assertBaselineUnchanged(root, options.baseline, context.baseline.manifest);
  return bundle;
}
