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

for (const version of ["3.0.0", "4.0.0"]) test(`legacy ${version} KG/news/diff transport stays plain JSON`, () => {
  for (const name of ["kg.json", "news.json", "diff.json"]) {
    assert.deepEqual(encodeAuditArtifact(raw, name, version), raw);
    assert.deepEqual(decodeAuditArtifact(raw, name, version), raw);
  }
});
test("v5 compresses only KG transport and preserves decoded bytes", () => {
  const encoded = encodeAuditArtifact(raw, "kg.json", "5.0.0");
  assert.deepEqual(encoded, gzipSync(raw, { level: 6 }));
  assert.deepEqual(decodeAuditArtifact(encoded, "kg.json", "5.0.0", raw.length), raw);
  for (const name of ["news.json", "diff.json", "source-review.json"]) assert.deepEqual(encodeAuditArtifact(raw, name, "5.0.0"), raw);
  assert.throws(() => decodeAuditArtifact(raw, "kg.json", "5.0.0"));
  for (const bytes of [encoded.subarray(0, 4), encoded.subarray(0, -1), Buffer.from("invalid gzip")]) assert.throws(() => decodeAuditArtifact(bytes, "kg.json", "5.0.0"));
  assert.throws(() => decodeAuditArtifact(encoded, "kg.json", "5.0.0", raw.length - 1));
  const bomb = gzipSync(Buffer.alloc(64 * 1024, 0x61));
  assert.ok(bomb.length < 1024);
  assert.throws(() => decodeAuditArtifact(bomb, "kg.json", "5.0.0", 1024));
});
