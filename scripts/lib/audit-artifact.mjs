import { gzipSync, gunzipSync } from "node:zlib";
import { encodeAuditJson, decodeAuditJson } from "./audit-json-codec.mjs";

const dictionaryArtifacts = new Set(["provenance.json.gz", "lifecycle.json.gz"]);
export function encodeAuditArtifact(bytes, name, version) {
  // The version, not the retained filename, selects the v5 KG wire encoding.
  if (version === "5.0.0" && name === "kg.json") return gzipSync(bytes, { level: 6 });
  if (!name.endsWith(".json.gz")) return bytes;
  return version === "5.0.0" && dictionaryArtifacts.has(name)
    ? encodeAuditJson(bytes) : gzipSync(bytes, { level: 6 });
}
export function decodeAuditArtifact(bytes, name, version, maxDecodedBytes = 512 * 1024 * 1024) {
  if (version === "5.0.0" && name === "kg.json") return gunzipSync(bytes, { maxOutputLength: maxDecodedBytes });
  if (!name.endsWith(".json.gz")) return bytes;
  return version === "5.0.0" && dictionaryArtifacts.has(name)
    ? decodeAuditJson(bytes, { maxDecodedBytes }) : gunzipSync(bytes, { maxOutputLength: maxDecodedBytes });
}
