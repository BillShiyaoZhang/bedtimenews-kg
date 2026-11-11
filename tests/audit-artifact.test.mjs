import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { encodeAuditArtifact, decodeAuditArtifact } from "../scripts/lib/audit-artifact.mjs";
import { acceptedArtifactNames, selectContentVersion } from "../scripts/lib/accepted-content-protocol.mjs";
const raw = Buffer.from('{"evidence":[{"id":"same","text":"完整证据"},{"id":"same","text":"完整证据"}]}\n');
for (const version of ["3.0.0", "4.0.0"]) test(`legacy ${version} audit bytes remain exactly unchanged`, () => {
  assert.deepEqual(encodeAuditArtifact(raw, "provenance.json.gz", version), gzipSync(raw, { level: 6 }));
});
for (const name of ["provenance.json.gz", "lifecycle.json.gz"]) test(`v5 ${name} is self-contained and byte-exact`, () => {
  const encoded = encodeAuditArtifact(raw, name, "5.0.0");
  assert.deepEqual(decodeAuditArtifact(encoded, name, "5.0.0"), raw);
  assert.notDeepEqual(gunzipSync(encoded), raw);
  assert.throws(() => decodeAuditArtifact(gzipSync(raw), name, "5.0.0"), /envelope/u);
});
test("v5 preserves original news content bytes and exact inventory", () => {
  assert.deepEqual(encodeAuditArtifact(raw, "news-content.json.gz", "5.0.0"), gzipSync(raw, { level: 6 }));
  assert.deepEqual(acceptedArtifactNames("5.0.0"), acceptedArtifactNames("4.0.0"));
  assert.equal(selectContentVersion("v5", "4.0.0"), "5.0.0");
  assert.equal(selectContentVersion(undefined, "5.0.0"), "5.0.0");
  assert.throws(() => selectContentVersion("v4", "5.0.0"), /drop/u);
});
