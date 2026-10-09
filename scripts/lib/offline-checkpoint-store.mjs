import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "./candidate-bundle.mjs";

const must = (value) => { if (!value) throw new Error("Offline checkpoint binding rejected"); };
const names = ["diff.json", "kg.json", "lifecycle.json.gz", "manifest.json", "news.json", "provenance.json.gz", "source-review.json"];

// The receipt comes from the opaque authenticated Git checkpoint, never from
// the downloaded directory. Every call rechecks all bytes; no network fallback.
export function createOfflineCheckpointStore({ directory, receipt }) {
  const expected = canonicalJson(receipt);
  const bindings = JSON.parse(expected).assets;
  must(canonicalJson(Object.keys(bindings).sort()) === canonicalJson(names));
  const root = resolve(directory);
  return Object.freeze({ async readBundle({ receipt: requested }) {
    must(canonicalJson(requested) === expected);
    must(canonicalJson((await readdir(root)).sort()) === canonicalJson(names));
    const files = new Map();
    for (const name of names) {
      const binding = bindings[name]; const path = resolve(root, name);
      const stat = await lstat(path);
      must(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === binding.bytes);
      const bytes = await readFile(path);
      must(bytes.length === binding.bytes && createHash("sha256").update(bytes).digest("hex") === binding.sha256);
      files.set(name, bytes);
    }
    const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
    const { bundleId, ...payload } = manifest;
    must(files.get("manifest.json").equals(Buffer.from(`${canonicalJson(manifest)}\n`))
      && manifest.schemaVersion === 1 && manifest.kind === "offline-candidate"
      && bundleId === requested.bundleId
      && createHash("sha256").update(canonicalJson(payload)).digest("hex") === bundleId
      && bindings["manifest.json"].sha256 === requested.manifestSha256
      && canonicalJson(Object.keys(manifest.artifacts).sort()) === canonicalJson(names.filter((name) => name !== "manifest.json")));
    for (const [name, binding] of Object.entries(manifest.artifacts)) {
      must(binding.bytes === bindings[name].bytes && binding.sha256 === bindings[name].sha256);
    }
    return { files, manifest };
  } });
}
