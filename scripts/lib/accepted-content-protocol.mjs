// Exact supported inventories, never a permissive union of filenames.
export const NEWS_CONTENT_PATH = "data/processed/news-content.json";
export const NEWS_CONTENT_ARTIFACT = "news-content.json.gz";
export const ACCEPTED_CONTENT_VERSIONS = Object.freeze(["3.0.0", "4.0.0"]);
const legacy = Object.freeze(["diff.json", "kg.json", "lifecycle.json.gz", "news.json", "provenance.json.gz", "source-review.json"]);
const current = Object.freeze([...legacy, NEWS_CONTENT_ARTIFACT].sort());
export function acceptedArtifactNames(version) {
  if (version === "2.0.0" || version === "3.0.0") return legacy;
  if (version === "4.0.0") return current;
  throw new Error("Accepted content protocol: unsupported candidate version");
}
export function acceptedBundleNames(version) { return [...acceptedArtifactNames(version), "manifest.json"].sort(); }
export function contentVersionFromFiles(names) {
  const actual = [...names].sort().join(",");
  for (const version of ACCEPTED_CONTENT_VERSIONS) if (actual === acceptedBundleNames(version).join(",")) return version;
  throw new Error("Accepted content protocol: missing or unknown bundle files");
}
export function selectContentVersion(requested, baselineVersion = "3.0.0") {
  if (requested !== undefined && !["v3", "v4"].includes(requested)) throw new Error("Accepted content protocol: use v3 or v4");
  const version = requested === "v4" ? "4.0.0" : requested === "v3" ? "3.0.0" : baselineVersion;
  acceptedArtifactNames(version);
  if (baselineVersion === "4.0.0" && version !== baselineVersion) throw new Error("Accepted content protocol: cannot silently drop recorded content");
  return version;
}
