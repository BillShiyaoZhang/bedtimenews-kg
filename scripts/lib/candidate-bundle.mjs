import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";

const MANIFEST = "manifest.json";
const HASH = /^[a-f0-9]{64}$/u;
const COLLECTIONS = ["entities", "events", "eventRelations", "entityRelations", "sources"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Strict, deterministic JSON. Object keys sort lexically; arrays retain order. */
export function canonicalJson(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (!Array.isArray(item) && !isObject(item)) throw new Error("Expected a JSON value.");
    if (ancestors.has(item)) throw new Error("Cyclic values are not JSON.");
    if (Reflect.ownKeys(item).some((key) => typeof key === "symbol")) {
      throw new Error("JSON values cannot contain symbol keys.");
    }
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new Error("Expected a dense JSON array.");
      result = `[${Array.from({ length: item.length }, (_, index) => encode(property(item, String(index)))).join(",")}]`;
    } else {
      result = `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(property(item, key))}`).join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}

function property(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("Expected JSON data properties.");
  return descriptor.value;
}

export function sha256(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) {
    throw new Error("sha256 expects a string or Buffer.");
  }
  return createHash("sha256").update(value).digest("hex");
}

function recordMap(value, collection, side) {
  if (!Array.isArray(value)) throw new Error(`${side}.${collection} must be an array.`);
  const records = new Map();
  for (const record of value) {
    if (!isObject(record) || typeof record.id !== "string" || !record.id.trim()) {
      throw new Error(`${side}.${collection} contains a missing or invalid stable ID.`);
    }
    if (records.has(record.id)) throw new Error(`Duplicate stable ID in ${side}.${collection}: ${record.id}.`);
    records.set(record.id, sha256(canonicalJson(record)));
  }
  return records;
}

/** Diff named record arrays by stable ID, independent of their outer ordering. */
export function diffRecords(before, after, { collections } = {}) {
  if (!isObject(before) || !isObject(after) || !Array.isArray(collections) || !collections.length ||
    collections.some((name) => typeof name !== "string" || !name.trim()) ||
    new Set(collections).size !== collections.length) {
    throw new Error("diffRecords requires objects and unique collection names.");
  }
  const results = [];
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const name of [...collections].sort()) {
    const oldRecords = recordMap(before[name], name, "before");
    const newRecords = recordMap(after[name], name, "after");
    const result = { added: [], removed: [], changed: [], unchanged: 0 };
    for (const id of [...new Set([...oldRecords.keys(), ...newRecords.keys()])].sort()) {
      const oldHash = oldRecords.get(id) ?? null;
      const newHash = newRecords.get(id) ?? null;
      if (oldHash === newHash) result.unchanged += 1;
      else result[oldHash === null ? "added" : newHash === null ? "removed" : "changed"].push({ id, oldHash, newHash });
    }
    for (const category of ["added", "removed", "changed"]) summary[category] += result[category].length;
    summary.unchanged += result.unchanged;
    results.push([name, result]);
  }
  return { summary, collections: Object.fromEntries(results) };
}

/** Ignore only the graph's top-level generatedAt; nested timestamps remain semantic. */
export function diffKnowledgeGraphs(before, after) {
  const result = diffRecords(before, after, { collections: COLLECTIONS });
  const metadata = (graph) => Object.fromEntries(Object.entries(graph)
    .filter(([key]) => key !== "generatedAt" && !COLLECTIONS.includes(key)));
  const oldHash = sha256(canonicalJson(metadata(before)));
  const newHash = sha256(canonicalJson(metadata(after)));
  return {
    ...result,
    metadata: { changed: oldHash !== newHash, oldHash, newHash },
    hasChanges: result.summary.added + result.summary.removed + result.summary.changed > 0 || oldHash !== newHash,
  };
}

function artifactName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json(?:\.gz)?$/u.test(name) ||
    [MANIFEST, `${MANIFEST}.gz`].includes(name.toLowerCase()) || name.includes("..")) {
    throw new Error(`Unsafe or reserved artifact filename: ${String(name)}.`);
  }
  return name;
}

function normalizeBindings(inputs, versions) {
  if (!isObject(inputs) || !Object.keys(inputs).length) throw new Error("inputs must contain hashed input bindings.");
  for (const [name, binding] of Object.entries(inputs)) {
    if (!name.trim() || !isObject(binding) || !HASH.test(binding.sha256 ?? "")) {
      throw new Error(`Invalid SHA-256 input binding: ${name}.`);
    }
  }
  if (!isObject(versions) || !Object.keys(versions).length ||
    Object.entries(versions).some(([name, value]) => !name.trim() || typeof value !== "string" || !value.trim())) {
    throw new Error("versions must contain nonempty named version strings.");
  }
  return JSON.parse(canonicalJson({ inputs, versions }));
}

function parseJson(bytes, name) {
  let value;
  try {
    const decoded = name.endsWith(".json.gz") ? gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }) : bytes;
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded), (_key, item) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite JSON number");
      return item;
    });
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error.message}`, { cause: error });
  }
  return value;
}

function freeze(value) {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

async function runValidator(validate, manifest, artifacts) {
  if (validate === undefined) return;
  if (typeof validate !== "function") throw new Error("validate must be a function.");
  const result = await validate(freeze({ artifacts, manifest, inputs: manifest.inputs, versions: manifest.versions }));
  if (result === false || (Array.isArray(result) && result.length)) {
    throw new Error(`Candidate validation failed${Array.isArray(result) ? `: ${canonicalJson(result)}` : "."}`);
  }
}

function bundleIdentity(manifest) {
  return sha256(canonicalJson({
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    artifacts: manifest.artifacts,
    inputs: manifest.inputs,
    versions: manifest.versions,
  }));
}

function prepareBundle(artifacts, inputs, versions) {
  if (!isObject(artifacts) || !Object.keys(artifacts).length) throw new Error("artifacts must be a nonempty JSON filename map.");
  const bindings = normalizeBindings(inputs, versions);
  const bytes = new Map();
  const values = [];
  const entries = [];
  const caseInsensitiveNames = new Set();
  for (const name of Object.keys(artifacts).sort()) {
    artifactName(name);
    if (caseInsensitiveNames.has(name.toLowerCase())) throw new Error(`Case-colliding artifact filename: ${name}.`);
    caseInsensitiveNames.add(name.toLowerCase());
    const value = property(artifacts, name);
    const suppliedBytes = Buffer.isBuffer(value) || typeof value === "string";
    const encoded = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(typeof value === "string" ? value : `${canonicalJson(value)}\n`);
    const content = name.endsWith(".json.gz") && !suppliedBytes ? gzipSync(encoded, { level: 6 }) : encoded;
    // Objects were strictly checked while encoding. Reuse/freeze them instead of
    // parsing a second full ledger into memory; supplied bytes still need parsing.
    values.push([name, suppliedBytes ? parseJson(content, name) : value]);
    entries.push([name, { sha256: sha256(content), bytes: content.length }]);
    bytes.set(name, content);
  }
  const manifest = {
    schemaVersion: 1,
    kind: "offline-candidate",
    ...bindings,
    artifacts: Object.fromEntries(entries),
  };
  manifest.bundleId = bundleIdentity(manifest);
  return { bytes, manifest, artifacts: Object.fromEntries(values) };
}

async function statOrMissing(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Never follow symlink ancestors, including when creating a candidate parent.
async function ensureDirectory(path, create = false) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    let stat = await statOrMissing(current);
    if (!stat && create) {
      try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
      stat = await lstat(current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Candidate path is not a real directory: ${current}.`);
    }
  }
  return absolute;
}

async function readRegularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Candidate files must be regular, unlinked files: ${path}.`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || stat.dev !== opened.dev || stat.ino !== opened.ino) {
      throw new Error(`Candidate file changed while opening: ${path}.`);
    }
    return await handle.readFile();
  } finally { await handle.close(); }
}

function validateManifest(manifest) {
  if (!isObject(manifest) || manifest.schemaVersion !== 1 || manifest.kind !== "offline-candidate" ||
    !HASH.test(manifest.bundleId ?? "") ||
    Object.keys(manifest).sort().join(",") !== "artifacts,bundleId,inputs,kind,schemaVersion,versions" ||
    !isObject(manifest.artifacts) || !Object.keys(manifest.artifacts).length) {
    throw new Error("Invalid or incomplete candidate manifest.");
  }
  normalizeBindings(manifest.inputs, manifest.versions);
  const names = new Set();
  for (const [name, binding] of Object.entries(manifest.artifacts)) {
    artifactName(name);
    if (names.has(name.toLowerCase())) throw new Error(`Case-colliding artifact filename: ${name}.`);
    names.add(name.toLowerCase());
    if (!isObject(binding) || Object.keys(binding).sort().join(",") !== "bytes,sha256" ||
      !HASH.test(binding.sha256 ?? "") || !Number.isSafeInteger(binding.bytes) || binding.bytes < 0) {
      throw new Error(`Invalid manifest artifact binding: ${name}.`);
    }
  }
  if (bundleIdentity(manifest) !== manifest.bundleId) throw new Error("Candidate bundleId mismatch.");
}

/** Verify every file and binding; a manifest alone never constitutes success. */
export async function verifyCandidateBundle(dir, { expectedInputs, validate } = {}) {
  const outputDir = await ensureDirectory(dir);
  const manifestBytes = await readRegularFile(join(outputDir, MANIFEST));
  const manifest = parseJson(manifestBytes, MANIFEST);
  validateManifest(manifest);
  if (!manifestBytes.equals(Buffer.from(`${canonicalJson(manifest)}\n`))) {
    throw new Error("Candidate manifest is not canonical JSON.");
  }
  if (expectedInputs !== undefined) {
    normalizeBindings(expectedInputs, manifest.versions);
    if (canonicalJson(expectedInputs) !== canonicalJson(manifest.inputs)) throw new Error("Candidate inputs mismatch.");
  }
  const expectedNames = [...Object.keys(manifest.artifacts), MANIFEST].sort();
  if (canonicalJson((await readdir(outputDir)).sort()) !== canonicalJson(expectedNames)) {
    throw new Error("Candidate bundle contains missing or extra files.");
  }
  const artifacts = [];
  for (const [name, binding] of Object.entries(manifest.artifacts)) {
    const bytes = await readRegularFile(join(outputDir, name));
    if (bytes.length !== binding.bytes || sha256(bytes) !== binding.sha256) {
      throw new Error(`Candidate artifact hash/size mismatch: ${name}.`);
    }
    artifacts.push([name, parseJson(bytes, name)]);
  }
  const values = Object.fromEntries(artifacts);
  await runValidator(validate, manifest, values);
  return { outputDir, manifest, artifacts: values };
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/**
 * Publish an offline candidate, never accepted data. Inputs are a nonempty map
 * of {sha256, ...JSON metadata}; callers bind compiler/generator bytes here.
 * Versions are nonempty strings. String/Buffer artifacts must contain JSON.
 * validate({artifacts, inputs, versions, manifest}) throws or returns false (or
 * nonempty issues[]) on failure. It runs before any writes and on readback.
 *
 * The optional third argument is a bounded failure-injection seam for tests:
 * beforeWrite({name,index}) and beforePublish() may throw, never replace I/O.
 * The exclusive sibling lock serializes cooperating publishers. Portable Node
 * rename cannot prevent a noncooperating writer racing the final absence check.
 */
export async function publishCandidateBundle(output, { artifacts, inputs, versions, validate }, hooks = {}) {
  if (typeof output !== "string" || !output.trim()) throw new Error("A candidate output directory is required.");
  if (!isObject(hooks) || Object.keys(hooks).some((name) =>
    !["beforeWrite", "beforePublish"].includes(name) || typeof hooks[name] !== "function")) {
    throw new Error("Invalid candidate publication hooks.");
  }
  const prepared = prepareBundle(artifacts, inputs, versions);
  await runValidator(validate, prepared.manifest, prepared.artifacts);
  const outputDir = resolve(output);
  if (outputDir === parse(outputDir).root) throw new Error("Cannot publish a candidate at the filesystem root.");
  await ensureDirectory(dirname(outputDir), true);
  const lock = `${outputDir}.publish-lock`;
  await mkdir(lock); // A stale or occupied lock is a safe failure, never stolen.
  let staging;
  try {
    if (await statOrMissing(outputDir)) {
      const existing = await verifyCandidateBundle(outputDir, { expectedInputs: prepared.manifest.inputs, validate });
      if (existing.manifest.bundleId !== prepared.manifest.bundleId) {
        throw new Error("Candidate destination already exists with a different bundle.");
      }
      return { ...existing, existing: true };
    }
    staging = await mkdtemp(join(dirname(outputDir), `.${basename(outputDir)}.candidate-`));
    let index = 0;
    for (const [name, bytes] of [...prepared.bytes, [MANIFEST, Buffer.from(`${canonicalJson(prepared.manifest)}\n`)]]) {
      await hooks.beforeWrite?.({ name, index: index++ });
      await writeExclusive(join(staging, name), bytes);
    }
    await hooks.beforePublish?.();
    const verified = await verifyCandidateBundle(staging, { expectedInputs: prepared.manifest.inputs, validate });
    if (verified.manifest.bundleId !== prepared.manifest.bundleId) throw new Error("Staged candidate identity changed.");
    if (await statOrMissing(outputDir)) throw new Error("Candidate destination appeared during publication.");
    await rename(staging, outputDir);
    staging = undefined;
    return { ...verified, outputDir, existing: false };
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { await rmdir(lock); }
  }
}
