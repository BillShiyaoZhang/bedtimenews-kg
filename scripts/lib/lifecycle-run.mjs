import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { canonicalJson, sha256, diffKnowledgeGraphs, diffRecords, publishCandidateBundle, verifyCandidateBundle } from "./candidate-bundle.mjs";
import { activeSnapshot, captureInputs, assertBaselineUnchanged, assertCandidateBudget, assertCandidateOutput, candidateVersions, candidateRuntimeBinding, provenanceBindings, sourceInventory, CANDIDATE_STORAGE_BUDGET } from "./candidate-run.mjs";
import { compileOntology } from "./ontology-compiler.mjs";
import { buildNewsDataset } from "./news-build.mjs";
import { buildKnowledgeGraph, canonicalDataset } from "./kg-build.mjs";
import { buildCandidateProvenance } from "./candidate-provenance.mjs";
import { planCandidateSourceReview, isSourceReviewTimestamp } from "./candidate-source-review.mjs";
import { assertGitSourceInventory, readVerifiedGitSources, readGitSourceHead } from "./source-snapshot.mjs";
import { buildCandidateLifecycle, summarizeCandidateLifecycleInput } from "./candidate-lifecycle.mjs";
import { validateNewsDataset, validateNewsFragments, validateKnowledgeBaseNewsProjection } from "./news.mjs";
import { validateTopicEvidence } from "./topic-evidence.mjs";
import { validate } from "./validate.mjs";
import { attachIdentityResolution, identityDiff } from "./identity-materialization.mjs";

const must = (value, message) => { if (!value) throw new Error(`Lifecycle candidate: ${message}`); };
const names = ["diff.json", "kg.json", "lifecycle.json.gz", "news.json", "provenance.json.gz", "source-review.json"];
const lifecycleVersion = "1.0.0";
const variableInputs = new Set(["recipe", "sourceInventory", "effectiveInventory", "baselineCandidate", "sourceReview"]);
const fixedInputs = (inputs) => Object.fromEntries(Object.entries(inputs).filter(([key]) => !variableInputs.has(key)));
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const hash = (value) => sha256(canonicalJson(value));

export function assertLifecycleBudget(manifest) {
  assertCandidateBudget(manifest);
  must(manifest.artifacts["lifecycle.json.gz"]?.bytes <= CANDIDATE_STORAGE_BUDGET.maxLedgerCompressedBytes, "lifecycle audit exceeds 64 MiB budget");
}

function checkHooks(hooks) {
  must(Object.keys(hooks).every((name) => ["afterInputSnapshot", "afterNewsRegeneration", "beforeVerifyReturn", "beforePublish"].includes(name) && typeof hooks[name] === "function"), "Invalid test hooks");
}

async function settings(root, options, hooks) {
  const sourceRoot = resolve(root, options.source ?? "sources/bedtimenews-archive-contents");
  must(await realpath(sourceRoot) === sourceRoot, "source root or ancestor is a symlink");
  const historyRoot = resolve(root, options.historyRoot ?? "work/lifecycle");
  assertCandidateOutput(root, historyRoot, sourceRoot);
  const snapshot = await activeSnapshot(root);
  const runtime = candidateRuntimeBinding();
  await hooks.afterInputSnapshot?.();
  const { ontology, rules } = compileOntology(snapshot.json("ontologySource"), snapshot.json("patterns"));
  must(snapshot.bytes.ontology.toString("utf8") === `${JSON.stringify(ontology, null, 2)}\n` && snapshot.bytes.rules.toString("utf8") === `${JSON.stringify(rules, null, 2)}\n`, "compiled ontology/rules are stale or hand-edited");
  const state = snapshot.json("acceptedState");
  const includedRoots = [...state.includedRoots].sort();
  must(!options.include || equal(String(options.include).split(",").sort(), includedRoots), "scope must equal accepted roots");
  return { root, sourceRoot, historyRoot, snapshot, runtime, ontology, rules, state, includedRoots, report: options.onProgress ?? (() => {}) };
}

async function inputsFor(context, inventory, effective, recipe, parentManifest, reviewBytes) {
  const inputs = await captureInputs(context.root, inventory, recipe, parentManifest, context.snapshot);
  must(equal(inputs.runtime, context.runtime), "runtime changed during lifecycle operation");
  inputs.effectiveInventory = { sha256: hash(effective), fileCount: Object.keys(effective).length };
  inputs.sourceReview = { sha256: sha256(reviewBytes) };
  return inputs;
}

function planFor(context, baseline, inventory, review) {
  if (!baseline) {
    must(review === null, "initial lifecycle baseline cannot contain a source review");
    must(equal(inventory, context.state.acceptedFiles), "initial lifecycle baseline must exactly replay accepted source inventory");
    return { observedInventory: inventory, effectiveInventory: inventory, sourceStates: {}, decisions: [], review: null };
  }
  return planCandidateSourceReview({ baselineBundleId: baseline.manifest.bundleId,
    baselineObservedInventory: baseline.lifecycle.observedInventory,
    baselineEffectiveInventory: baseline.lifecycle.effectiveInventory,
    baselineSourceStates: baseline.lifecycle.sourceStates,
    currentInventory: inventory, includedRoots: context.includedRoots, review });
}

function assertNewsContinuity(baseline, current, plan) {
  if (!baseline) return;
  const ids = (dataset, path) => {
    const page = dataset.pages.find((entry) => entry.repositoryPath === path);
    return dataset.news.filter((entry) => entry.pageId === page?.id).sort((a, b) => a.fragment.ordinal - b.fragment.ordinal).map((entry) => entry.id);
  };
  for (const decision of plan.decisions) {
    if (decision.operation !== "revise" || !baseline.lifecycle.effectiveInventory[decision.path] || !plan.effectiveInventory[decision.path]) continue;
    must(equal(ids(baseline.news, decision.path), ids(current, decision.path)), `news boundary/identity migration requires a separately implemented review: ${decision.path}`);
  }
}

function diffFor(context, baseline, current, lifecycle) {
  const reviewed = identityDiff(baseline?.kg ?? context.snapshot.json("acceptedKG"), current.kg);
  if (reviewed.identity && lifecycle.identityResolution) {
    reviewed.identity.lifecycleTransitionsHash = hash(lifecycle.identityResolution.transitions);
    reviewed.identity.transitionCounts = Object.fromEntries(Object.entries(lifecycle.identityResolution.transitions).map(([kind, rows]) => [kind, rows.length]));
  }
  return { schemaVersion: "2.0.0", epistemicScope: "extraction_assignment",
    graph: diffKnowledgeGraphs(baseline?.kg ?? context.snapshot.json("acceptedKG"), current.kg),
    ...reviewed,
    news: diffRecords(baseline?.news ?? context.snapshot.json("acceptedNews"), current.news, { collections: ["pages", "news"] }),
    lifecycle: { baselineBundleId: baseline?.manifest.bundleId ?? null, transitionsHash: hash(lifecycle.transitions),
      note: "Each assignment belongs to its own news projection. Withdrawn support never labels a real-world claim false." } };
}

async function materialize(context, recipe, plan, inputs, baseline, review) {
  const temporary = await mkdtemp(resolve(tmpdir(), "kg-lifecycle-snapshot-"));
  try {
    // Every observed source, including excluded/unpublished files, must match the exact historical commit.
    await assertGitSourceInventory({ sourceRoot: context.sourceRoot, commit: recipe.archiveCommit, inventory: plan.observedInventory, includedRoots: context.includedRoots, verifyWorkingTree: false });
    const texts = new Map();
    const historicalBytes = await readVerifiedGitSources({ sourceRoot: context.sourceRoot, commit: recipe.archiveCommit, inventory: plan.effectiveInventory });
    for (const [path, bytes] of historicalBytes) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      texts.set(path, text);
      await mkdir(dirname(resolve(temporary, path)), { recursive: true });
      await writeFile(resolve(temporary, path), bytes);
    }
    historicalBytes.clear();
    const { dataset: generated } = await buildNewsDataset({ sourceEntries: [...texts.keys()], readSource: (path) => texts.get(path), overrides: context.snapshot.json("newsOverrides"), generatedAt: recipe.generatedAt });
    const dataset = canonicalDataset(generated);
    assertNewsContinuity(baseline, dataset, plan);
    const rawPages = new Map(dataset.pages.map((page) => [page.id, texts.get(page.repositoryPath)]));
    const built = buildKnowledgeGraph({ dataset, rawPages, ontology: context.ontology, rules: context.rules, generatedAt: recipe.generatedAt, collectTrace: true });
    const provenance = buildCandidateProvenance({ kg: built.kg, dataset, sourceInventory: plan.effectiveInventory, rawPages, trace: built.trace, bindings: provenanceBindings(inputs) });
    built.trace = null;
    const kg = attachIdentityResolution({ kg: built.kg, news: dataset, provenance, config: context.snapshot.bytes.identityRegistry ? context.snapshot.json("identityRegistry") : null, baselineOverlay: baseline?.kg.identityResolution?.overlay ?? null });
    const issues = [...validateNewsDataset(dataset), ...validate(kg, context.ontology), ...validateKnowledgeBaseNewsProjection(kg, dataset), ...await validateNewsFragments(dataset, temporary), ...await validateTopicEvidence(kg, dataset, context.rules, temporary)];
    must(!issues.length, issues.slice(0, 15).map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    const current = { kg, news: dataset, provenance };
    const summary = summarizeCandidateLifecycleInput(current);
    const lifecycle = buildCandidateLifecycle({ baseline: baseline ? { bundleId: baseline.manifest.bundleId, summary: baseline.summary, lifecycle: baseline.lifecycle } : null, current: { summary }, sourcePlan: plan });
    return { "kg.json": kg, "news.json": dataset, "provenance.json.gz": provenance, "lifecycle.json.gz": lifecycle, "source-review.json": review, "diff.json": diffFor(context, baseline, current, lifecycle) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function versionsFor(context, dataset) {
  return { ...candidateVersions({ ontology: context.ontology, rules: context.rules, dataset }), candidate: "2.0.0", lifecycle: lifecycleVersion };
}

function assertArtifacts(actual, expected) {
  must(equal(Object.keys(actual).sort(), names), "incomplete lifecycle artifacts");
  for (const name of names) {
    if (name === "provenance.json.gz") {
      must(equal(Object.keys(actual[name]).sort(), Object.keys(expected[name]).sort()), "provenance tables differ");
      for (const key of Object.keys(expected[name])) must(hash(actual[name][key]) === hash(expected[name][key]), `provenance ${key} differs from historical replay`);
    } else must(hash(actual[name]) === hash(expected[name]), `${name} differs from historical replay`);
  }
}

async function manifestAt(directory) {
  const stat = await lstat(directory);
  must(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(directory) === resolve(directory), "history directory or ancestor is a symlink");
  const file = resolve(directory, "manifest.json");
  const fileStat = await lstat(file);
  must(fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.nlink === 1, "unsafe history manifest");
  const bytes = await readFile(file, "utf8");
  const manifest = JSON.parse(bytes);
  must(/^[a-f0-9]{64}$/u.test(manifest.bundleId), "invalid history bundle ID");
  const { bundleId, ...payload } = manifest;
  must(hash(payload) === bundleId && bytes === `${canonicalJson(manifest)}\n`, "history manifest identity mismatch");
  must(manifest.versions?.lifecycle === lifecycleVersion, "baseline needs an explicitly replayed lifecycle migration; Stage C bundles are diff-only");
  return manifest;
}

async function historyChain(context, directory) {
  const target = resolve(context.root, directory);
  must(dirname(target) === context.historyRoot, "all lifecycle bundles must be direct children of history-root");
  const targetManifest = await manifestAt(target);
  const index = new Map([[targetManifest.bundleId, { directory: target, manifest: targetManifest }]]);
  for (const entry of await readdir(context.historyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || resolve(context.historyRoot, entry.name) === target) continue;
    const path = resolve(context.historyRoot, entry.name);
    let manifest;
    try { manifest = await manifestAt(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    must(!index.has(manifest.bundleId), "duplicate bundle identity in history-root");
    index.set(manifest.bundleId, { directory: path, manifest });
  }
  const chain = []; const seen = new Set(); let current = index.get(targetManifest.bundleId);
  while (current) {
    const id = current.manifest.bundleId;
    must(!seen.has(id), "cyclic history"); seen.add(id); chain.unshift(current);
    const parent = current.manifest.inputs.baselineCandidate;
    if (!parent) break;
    const resolved = index.get(parent.bundleId);
    must(resolved, `referenced historical bundle unavailable: ${parent.bundleId}`);
    must(parent.sha256 === hash(resolved.manifest), "parent manifest hash mismatch");
    current = resolved;
  }
  return chain;
}

async function replayHistory(context, directory) {
  if (!directory) return { baseline: null, chain: [] };
  const chain = await historyChain(context, directory);
  let baseline = null;
  for (const item of chain) {
    context.report(`replay historical bundle ${item.manifest.bundleId.slice(0, 12)}`);
    const bundle = await verifyCandidateBundle(item.directory);
    assertLifecycleBudget(bundle.manifest);
    must(equal(bundle.manifest, item.manifest), "historical bundle changed while reading chain");
    const storedRecipe = bundle.manifest.inputs.recipe;
    must(storedRecipe && equal(Object.keys(storedRecipe).sort(), ["archiveCommit", "generatedAt", "includedRoots", "sha256", "storageBudget"]), "historical recipe has unknown or missing fields");
    const recipe = { archiveCommit: storedRecipe.archiveCommit, generatedAt: storedRecipe.generatedAt, includedRoots: storedRecipe.includedRoots, storageBudget: storedRecipe.storageBudget };
    must(storedRecipe.sha256 === hash(recipe), "historical recipe hash mismatch");
    must(equal(recipe.includedRoots, context.includedRoots) && equal(recipe.storageBudget, CANDIDATE_STORAGE_BUDGET), "historical recipe scope/budget mismatch");
    must(isSourceReviewTimestamp(recipe.generatedAt), "invalid historical timestamp");
    must(equal(fixedInputs(bundle.manifest.inputs), fixedInputs(await captureInputs(context.root, {}, recipe, null, context.snapshot))), "semantic configuration, accepted origin, generator or runtime changed; explicit migration required");
    const lifecycle = bundle.artifacts["lifecycle.json.gz"];
    must(lifecycle, "missing historical lifecycle");
    const reviewBytes = await readFile(resolve(item.directory, "source-review.json"));
    must(sha256(reviewBytes) === bundle.manifest.inputs.sourceReview?.sha256, "historical review bytes mismatch");
    const review = JSON.parse(reviewBytes.toString("utf8"));
    const plan = planFor(context, baseline, lifecycle.observedInventory, review);
    const inputs = await inputsFor(context, plan.observedInventory, plan.effectiveInventory, recipe, baseline?.manifest, reviewBytes);
    must(equal(inputs, bundle.manifest.inputs), "historical input binding mismatch");
    const expected = await materialize(context, recipe, plan, inputs, baseline, review);
    must(equal(versionsFor(context, expected["news.json"]), bundle.manifest.versions), "historical version labels mismatch");
    assertArtifacts(bundle.artifacts, expected);
    item.inventory = plan.observedInventory;
    const summary = summarizeCandidateLifecycleInput({ kg: expected["kg.json"], news: expected["news.json"], provenance: expected["provenance.json.gz"] });
    baseline = { manifest: bundle.manifest, kg: expected["kg.json"], news: expected["news.json"], lifecycle: expected["lifecycle.json.gz"], summary };
  }
  return { baseline, chain };
}

async function recheck(context, chain, inventory, reviewFile, reviewBytes, recipe) {
  must(equal(candidateRuntimeBinding(), context.runtime), "runtime changed during lifecycle operation");
  must(equal((await activeSnapshot(context.root)).inputs, context.snapshot.inputs), "active semantic configuration or accepted data changed during lifecycle operation");
  if (inventory) must(equal(await sourceInventory(context.sourceRoot, context.includedRoots, { allowEmpty: true }), inventory), "source inventory changed during lifecycle operation");
  if (reviewFile) must((await readFile(reviewFile)).equals(reviewBytes), "source review changed during lifecycle operation");
  for (const item of chain) {
    await assertBaselineUnchanged(context.root, item.directory, item.manifest);
    await assertGitSourceInventory({ sourceRoot: context.sourceRoot, commit: item.manifest.inputs.recipe.archiveCommit, inventory: item.inventory, includedRoots: context.includedRoots, verifyWorkingTree: false });
  }
  if (inventory && recipe) await assertGitSourceInventory({ sourceRoot: context.sourceRoot, commit: recipe.archiveCommit, inventory, includedRoots: context.includedRoots });
}

export async function buildLifecycleCandidate(root, options = {}, hooks = {}) {
  checkHooks(hooks); const start = performance.now();
  const context = await settings(root, options, hooks);
  const { baseline, chain } = await replayHistory(context, options.baseline);
  const inventory = await sourceInventory(context.sourceRoot, context.includedRoots, { allowEmpty: true });
  const reviewFile = options.sourceReview ? resolve(root, options.sourceReview) : null;
  const reviewBytes = reviewFile ? await readFile(reviewFile) : Buffer.from("null\n");
  const review = JSON.parse(reviewBytes.toString("utf8"));
  const plan = planFor(context, baseline, inventory, review);
  const { commit, committedAt } = await readGitSourceHead({ sourceRoot: context.sourceRoot });
  const generatedAt = options.generatedAt ?? committedAt;
  must(isSourceReviewTimestamp(generatedAt), "valid pinned generatedAt required");
  const recipe = { includedRoots: context.includedRoots, archiveCommit: commit, generatedAt, storageBudget: CANDIDATE_STORAGE_BUDGET };
  const inputs = await inputsFor(context, inventory, plan.effectiveInventory, recipe, baseline?.manifest, reviewBytes);
  context.report("materialize effective sources, scoped supports and dormant identities");
  const artifacts = await materialize(context, recipe, plan, inputs, baseline, review);
  await hooks.afterNewsRegeneration?.();
  await recheck(context, chain, inventory, reviewFile, reviewBytes, recipe);
  const output = resolve(root, options.output ?? resolve(context.historyRoot, hash(inputs).slice(0, 20)));
  must(dirname(output) === context.historyRoot && !basename(output).startsWith("."), "output must be a direct non-hidden child of history-root");
  assertCandidateOutput(root, output, context.sourceRoot, options.baseline);
  const versions = versionsFor(context, artifacts["news.json"]);
  let verifiedBundleId = null;
  // Exact review file bytes are part of the immutable artifact and input binding.
  artifacts["source-review.json"] = reviewBytes;
  const result = await publishCandidateBundle(output, { artifacts, inputs, versions,
    validate: async ({ artifacts: actual, manifest }) => {
      assertLifecycleBudget(manifest);
      must(equal(manifest.inputs, inputs) && equal(manifest.versions, versions), "publication recipe mismatch");
      await recheck(context, chain, inventory, reviewFile, reviewBytes, recipe);
      if (verifiedBundleId !== manifest.bundleId) {
        context.report("independently replay new candidate before atomic offline publication");
        const expected = await materialize(context, recipe, plan, inputs, baseline, review);
        assertArtifacts(actual, expected);
        verifiedBundleId = manifest.bundleId;
      }
      return [];
    },
  }, { beforePublish: async () => { await hooks.beforePublish?.(); await recheck(context, chain, inventory, reviewFile, reviewBytes, recipe); } });
  return { ...result, metrics: { elapsedMs: Math.round(performance.now() - start), maxRssKiB: process.resourceUsage().maxRSS, historyBundles: chain.length, news: artifacts["news.json"].news.length, entities: artifacts["kg.json"].entities.length, supports: artifacts["provenance.json.gz"].supports.length, artifactBytes: Object.values(result.manifest.artifacts).reduce((total, value) => total + value.bytes, 0) } };
}

export async function verifyLifecycleCandidate(root, directory, options = {}, hooks = {}) {
  checkHooks(hooks); const context = await settings(root, options, hooks);
  const { baseline, chain } = await replayHistory(context, directory);
  await hooks.beforeVerifyReturn?.();
  await recheck(context, chain);
  return { manifest: baseline.manifest, historyBundles: chain.length };
}

// Shared deterministic builders. The offline v1 runner above still replays its
// entire ancestry and keeps its original fixed-input contract. Production's
// separately versioned trusted-checkpoint runner only reuses these primitives.
export { settings as lifecycleCandidateSettings, inputsFor as lifecycleCandidateInputs,
  planFor as planLifecycleSources, materialize as materializeLifecycleCandidate,
  assertArtifacts as assertLifecycleArtifacts };
