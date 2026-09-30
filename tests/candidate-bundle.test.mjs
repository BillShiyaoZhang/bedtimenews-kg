import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalJson,
  diffKnowledgeGraphs,
  diffRecords,
  publishCandidateBundle,
  sha256,
  verifyCandidateBundle,
} from "../scripts/lib/candidate-bundle.mjs";

const inputs = {
  generator: { sha256: sha256("generator source"), path: "scripts/build-kg.mjs" },
  compiler: { sha256: sha256("compiler source"), path: "scripts/lib/ontology-compiler.mjs" },
  ontology: { sha256: sha256("ontology bytes"), revision: "fixture" },
};
const versions = { generator: "1.0.0", compiler: "1.0.0" };

function bundle(overrides = {}) {
  return {
    inputs,
    versions,
    artifacts: {
      "kg.json": { entities: [{ id: "entity-a", label: "A" }], generatedAt: "2026-09-30T00:00:00Z" },
      "support-ledger.json": { assertions: [{ id: "assertion-a", supports: ["news-a"] }] },
    },
    ...overrides,
  };
}

function graph(overrides = {}) {
  return { schemaVersion: "1", generatedAt: "old", entities: [], events: [], eventRelations: [], entityRelations: [], sources: [], ...overrides };
}

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "kg-candidate-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("canonical JSON sorts keys including numeric keys, preserves array ordering, and hashes exact bytes", () => {
  assert.equal(canonicalJson({ z: 3, b: [{ z: 2, a: 1 }, "中"], a: 1 }), '{"a":1,"b":[{"a":1,"z":2},"中"],"z":3}');
  assert.equal(canonicalJson({ 2: "two", 10: "ten" }), '{"10":"ten","2":"two"}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256("中"), sha256(Buffer.from("中")));
  assert.throws(() => sha256({}), /string or Buffer/u);
});

test("canonical JSON rejects non-JSON data without invoking getters", () => {
  const cyclic = {}; cyclic.self = cyclic;
  let invoked = false;
  const getter = { get value() { invoked = true; return 1; } };
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), cyclic, [, 1], { a: undefined }, getter, { [Symbol("x")]: 1 }]) {
    assert.throws(() => canonicalJson(value));
  }
  assert.equal(invoked, false);
  const shared = { a: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"a":1},{"a":1}]');
});

test("stable-ID diff reports sorted full IDs and old/new hashes, not positional changes", () => {
  const before = { things: [{ id: "unchanged", x: 1 }, { id: "removed", x: 2 }, { id: "changed", x: 3 }] };
  const after = { things: [{ id: "changed", x: 4 }, { id: "added-z" }, { id: "unchanged", x: 1 }, { id: "added-a" }] };
  const diff = diffRecords(before, after, { collections: ["things"] });
  assert.deepEqual(diff.summary, { added: 2, removed: 1, changed: 1, unchanged: 1 });
  assert.deepEqual(diff.collections.things.added.map(({ id }) => id), ["added-a", "added-z"]);
  assert.deepEqual(diff.collections.things.changed, [{ id: "changed", oldHash: sha256(canonicalJson(before.things[2])), newHash: sha256(canonicalJson(after.things[0])) }]);
  assert.equal(diff.collections.things.added[0].oldHash, null);
  assert.equal(diff.collections.things.removed[0].newHash, null);
  assert.deepEqual(diff, diffRecords({ things: [...before.things].reverse() }, { things: [...after.things].reverse() }, { collections: ["things"] }));
});

test("diff rejects missing, invalid, duplicate IDs and malformed collection declarations on either side", () => {
  for (const invalid of [[{}], [{ id: "" }], [{ id: "  " }], [{ id: 12 }], [{ id: "a" }, { id: "a" }]]) {
    assert.throws(() => diffRecords({ c: [] }, { c: invalid }, { collections: ["c"] }), /ID/u);
    assert.throws(() => diffRecords({ c: invalid }, { c: [] }, { collections: ["c"] }), /ID/u);
  }
  assert.throws(() => diffRecords({}, {}, { collections: ["c"] }), /array/u);
  for (const collections of [undefined, [], ["c", "c"], [""], [1]]) {
    assert.throws(() => diffRecords({}, {}, { collections }), /unique collection names/u);
  }
});

test("knowledge graph diff covers every collection and ignores only top-level generatedAt", () => {
  const before = graph();
  const after = graph({ generatedAt: "new" });
  assert.equal(diffKnowledgeGraphs(before, after).hasChanges, false);
  for (const collection of ["entities", "events", "eventRelations", "entityRelations", "sources"]) {
    const diff = diffKnowledgeGraphs(before, { ...after, [collection]: [{ id: `${collection}-new` }] });
    assert.equal(diff.hasChanges, true);
    assert.equal(diff.collections[collection].added.length, 1);
  }
  assert.equal(diffKnowledgeGraphs(before, { ...after, schemaVersion: "2" }).metadata.changed, true);
  assert.equal(diffKnowledgeGraphs(before, { ...after, source: { generatedAt: "semantic" } }).hasChanges, true);
  const nested = graph({ entities: [{ id: "a", generatedAt: "old" }] });
  assert.equal(diffKnowledgeGraphs(nested, graph({ entities: [{ id: "a", generatedAt: "new" }] })).summary.changed, 1);
  assert.equal(diffKnowledgeGraphs(graph({ entities: [{ id: "a", aliases: ["x", "y"] }] }), graph({ entities: [{ id: "a", aliases: ["y", "x"] }] })).summary.changed, 1);
});

test("candidate publication is deterministic, verifies all bindings, and is idempotent", async (t) => {
  const root = await sandbox(t);
  const first = await publishCandidateBundle(join(root, "first"), bundle());
  const reordered = bundle({
    inputs: Object.fromEntries(Object.entries(inputs).reverse()),
    versions: { compiler: "1.0.0", generator: "1.0.0" },
    artifacts: Object.fromEntries(Object.entries(bundle().artifacts).reverse()),
  });
  const second = await publishCandidateBundle(join(root, "second"), reordered);
  assert.equal(first.existing, false);
  assert.equal(second.manifest.bundleId, first.manifest.bundleId);
  assert.deepEqual(first.manifest.inputs, inputs);
  assert.deepEqual(first.manifest.versions, versions);
  assert.equal(first.manifest.kind, "offline-candidate");
  assert.equal(Object.hasOwn(first.manifest, "generatedAt"), false);
  for (const name of await readdir(first.outputDir)) {
    assert.deepEqual(await readFile(join(first.outputDir, name)), await readFile(join(second.outputDir, name)));
  }
  const repeated = await publishCandidateBundle(first.outputDir, reordered);
  assert.equal(repeated.existing, true);
  assert.deepEqual(repeated.manifest, first.manifest);
  const verified = await verifyCandidateBundle(first.outputDir, { expectedInputs: inputs });
  assert.deepEqual(verified.artifacts, bundle().artifacts);
  for (const [name, binding] of Object.entries(verified.manifest.artifacts)) {
    const bytes = await readFile(join(first.outputDir, name));
    assert.equal(binding.bytes, bytes.length);
    assert.equal(binding.sha256, sha256(bytes));
  }
});

test("JSON strings and buffers retain exact bytes and validate parsed values", async (t) => {
  const root = await sandbox(t);
  const json = '{ "text": "中", "values": [2, 1] }\n';
  const artifacts = { "text.json": json, "buffer.json": Buffer.from("[1,true,null]\n") };
  const result = await publishCandidateBundle(join(root, "candidate"), bundle({ artifacts }));
  assert.equal(await readFile(join(result.outputDir, "text.json"), "utf8"), json);
  assert.equal(result.manifest.artifacts["text.json"].bytes, Buffer.byteLength(json));
  assert.deepEqual(result.artifacts["buffer.json"], [1, true, null]);
});

test("unsafe filenames and malformed inputs fail before creating any output parents", async (t) => {
  const root = await sandbox(t);
  const output = join(root, "not-created", "candidate");
  for (const name of ["../escape.json", "nested/file.json", "/absolute.json", "x\\file.json", "manifest.json", "MANIFEST.json", "x.txt", ".hidden.json", "x..json", "x.json\0"]) {
    await assert.rejects(publishCandidateBundle(output, bundle({ artifacts: { [name]: {} } })), /filename/u);
  }
  for (const artifacts of [{}, { "a.json": "not JSON" }, { "a.json": Buffer.from([0xff]) }, { "a.json": undefined }, { "a.json": "1e999" }, { "a.json": {}, "A.json": {} }]) {
    await assert.rejects(publishCandidateBundle(output, bundle({ artifacts })));
  }
  for (const invalid of [{}, { compiler: "x" }, { compiler: { sha256: "bad" } }, { compiler: { sha256: "A".repeat(64) } }, { compiler: { sha256: sha256("x"), metadata: NaN } }]) {
    await assert.rejects(publishCandidateBundle(output, bundle({ inputs: invalid })));
  }
  for (const invalid of [{}, { compiler: "" }, { compiler: 1 }, { "": "1" }]) {
    await assert.rejects(publishCandidateBundle(output, bundle({ versions: invalid })), /versions/u);
  }
  await absent(join(root, "not-created"));
  assert.deepEqual(await readdir(root), []);
});

test("validation sees immutable complete payloads and fails before filesystem writes", async (t) => {
  const root = await sandbox(t);
  const output = join(root, "not-created", "candidate");
  await assert.rejects(publishCandidateBundle(output, bundle({ validate: async (context) => {
    assert.deepEqual(context.inputs, inputs);
    assert.equal(context.manifest.kind, "offline-candidate");
    assert.equal(context.artifacts["kg.json"].entities[0].id, "entity-a");
    assert.equal(Object.isFrozen(context.artifacts["kg.json"].entities[0]), true);
    throw new Error("semantic validation failed");
  } })), /semantic validation failed/u);
  await absent(join(root, "not-created"));
  await assert.rejects(publishCandidateBundle(output, bundle({ validate: () => false })), /validation failed/u);
  await assert.rejects(publishCandidateBundle(output, bundle({ validate: () => [{ message: "bad support" }] })), /bad support/u);
  await assert.rejects(publishCandidateBundle(output, bundle({ validate: "not a callback" })), /function/u);
});

test("publication writes manifest last and readback validation completes before atomic visibility", async (t) => {
  const root = await sandbox(t);
  const output = join(root, "candidate");
  const writes = [];
  let validations = 0;
  const result = await publishCandidateBundle(output, bundle({ validate: async () => {
    validations += 1;
    await absent(output);
  } }), {
    beforeWrite: async ({ name, index }) => {
      assert.equal(index, writes.length);
      writes.push(name);
      await absent(output);
    },
    beforePublish: async () => {
      assert.equal(writes.at(-1), "manifest.json");
      await absent(output);
    },
  });
  assert.equal(validations, 2);
  assert.equal(writes.at(-1), "manifest.json");
  assert.deepEqual(await readdir(root), ["candidate"]);
  assert.equal((await verifyCandidateBundle(output)).manifest.bundleId, result.manifest.bundleId);
});

test("bounded writer failures leave no candidate, staging files, locks, or accepted-data changes", async (t) => {
  const root = await sandbox(t);
  const accepted = join(root, "accepted.json");
  await writeFile(accepted, "accepted data stays byte-identical\n");
  const previous = await readFile(accepted);
  const output = join(root, "candidate");
  for (const failureIndex of [0, 1, 2]) {
    await assert.rejects(publishCandidateBundle(output, bundle(), { beforeWrite: ({ index }) => {
      if (index === failureIndex) throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    } }), /simulated EIO/u);
    await absent(output);
    assert.deepEqual(await readdir(root), ["accepted.json"]);
    assert.deepEqual(await readFile(accepted), previous);
  }
  await assert.rejects(publishCandidateBundle(output, bundle(), { beforePublish: () => { throw new Error("interrupted publication"); } }), /interrupted publication/u);
  assert.deepEqual(await readdir(root), ["accepted.json"]);
  assert.deepEqual(await readFile(accepted), previous);
});

test("readback validator failure cleans all unpublished output", async (t) => {
  const root = await sandbox(t);
  let calls = 0;
  await assert.rejects(publishCandidateBundle(join(root, "candidate"), bundle({ validate: () => {
    calls += 1;
    if (calls === 2) throw new Error("readback failure");
  } })), /readback failure/u);
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(root), []);
});

test("existing destinations are never replaced, including different or corrupt candidates", async (t) => {
  const root = await sandbox(t);
  const output = join(root, "candidate");
  const result = await publishCandidateBundle(output, bundle());
  const bytes = await readFile(join(output, "kg.json"));
  await assert.rejects(publishCandidateBundle(output, bundle({ artifacts: { "kg.json": { changed: true } } })), /different bundle/u);
  assert.deepEqual(await readFile(join(output, "kg.json")), bytes);
  await assert.rejects(publishCandidateBundle(output, bundle({ inputs: { ...inputs, compiler: { sha256: sha256("new compiler") } } })), /inputs mismatch/u);
  await assert.rejects(publishCandidateBundle(output, bundle({ versions: { ...versions, generator: "2" } })), /different bundle/u);
  assert.equal((await verifyCandidateBundle(output)).manifest.bundleId, result.manifest.bundleId);
  await writeFile(join(output, "kg.json"), "{}\n");
  await assert.rejects(publishCandidateBundle(output, bundle()), /hash\/size mismatch/u);
  assert.equal(await readFile(join(output, "kg.json"), "utf8"), "{}\n");
  const empty = join(root, "empty");
  await mkdir(empty);
  await assert.rejects(publishCandidateBundle(empty, bundle()), { code: "ENOENT" });
  assert.deepEqual(await readdir(empty), []);
});

test("publication refuses a destination that appears before final verification", async (t) => {
  const root = await sandbox(t);
  const output = join(root, "candidate");
  await assert.rejects(publishCandidateBundle(output, bundle(), { beforePublish: async () => {
    await mkdir(output);
    await writeFile(join(output, "sentinel"), "unrelated writer");
  } }), /appeared during publication/u);
  assert.deepEqual(await readdir(root), ["candidate"]);
  assert.equal(await readFile(join(output, "sentinel"), "utf8"), "unrelated writer");
});

test("cooperating concurrent publishers cannot overwrite or publish partial bundles", async (t) => {
  const root = await sandbox(t);
  const output = join(root, "candidate");
  const results = await Promise.allSettled([publishCandidateBundle(output, bundle()), publishCandidateBundle(output, bundle())]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  for (const result of results) {
    if (result.status === "rejected") assert.equal(result.reason.code, "EEXIST");
  }
  assert.deepEqual((await verifyCandidateBundle(output)).artifacts, bundle().artifacts);
  assert.deepEqual(await readdir(root), ["candidate"]);
});

test("verification rejects corrupt bytes, missing artifacts, extra files, and partial outputs", async (t) => {
  const root = await sandbox(t);
  for (const mode of ["corrupt", "missing", "extra", "missing-manifest", "extra-directory"]) {
    const output = join(root, mode);
    await publishCandidateBundle(output, bundle());
    if (mode === "corrupt") await writeFile(join(output, "kg.json"), "{}\n");
    if (mode === "missing") await rm(join(output, "kg.json"));
    if (mode === "extra") await writeFile(join(output, "extra.json"), "{}\n");
    if (mode === "missing-manifest") await rm(join(output, "manifest.json"));
    if (mode === "extra-directory") await mkdir(join(output, "extra"));
    await assert.rejects(verifyCandidateBundle(output));
  }
});

test("verification rejects malformed, incomplete, tampered, noncanonical manifests and wrong input bindings", async (t) => {
  const root = await sandbox(t);
  const output = join(root, "candidate");
  const { manifest } = await publishCandidateBundle(output, bundle());
  await assert.rejects(verifyCandidateBundle(output, { expectedInputs: { compiler: { sha256: sha256("wrong") } } }), /inputs mismatch/u);
  await assert.rejects(verifyCandidateBundle(output, { expectedInputs: {} }), /hashed input bindings/u);
  const mutations = [
    { ...manifest, bundleId: "0".repeat(64) },
    { ...manifest, artifacts: {} },
    { ...manifest, unexpected: true },
    { ...manifest, inputs: {} },
    { ...manifest, artifacts: { "../evil.json": { sha256: sha256("{}"), bytes: 2 } } },
    { ...manifest, artifacts: { "kg.json": { sha256: "bad", bytes: -1 } } },
  ];
  for (const mutated of mutations) {
    await writeFile(join(output, "manifest.json"), `${canonicalJson(mutated)}\n`);
    await assert.rejects(verifyCandidateBundle(output));
  }
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  await assert.rejects(verifyCandidateBundle(output), /canonical JSON/u);
  await writeFile(join(output, "manifest.json"), `${canonicalJson(manifest)}\n`);
  await assert.rejects(verifyCandidateBundle(output, { validate: () => false }), /validation failed/u);
});

test("symlinked and hardlinked artifacts and symlinked destination ancestors are rejected", async (t) => {
  const root = await sandbox(t);
  const source = join(root, "source.json");
  const result = await publishCandidateBundle(join(root, "candidate"), bundle());
  const target = join(result.outputDir, "kg.json");
  await writeFile(source, await readFile(target));
  await rm(target);
  await symlink(source, target);
  await assert.rejects(verifyCandidateBundle(result.outputDir), /regular, unlinked/u);
  await rm(target);
  await link(source, target);
  await assert.rejects(verifyCandidateBundle(result.outputDir), /regular, unlinked/u);
  const linked = join(root, "linked");
  await symlink(result.outputDir, linked);
  await assert.rejects(verifyCandidateBundle(linked), /real directory/u);
  await assert.rejects(publishCandidateBundle(join(linked, "nested"), bundle()), /real directory/u);
  await absent(join(result.outputDir, "nested"));
});


test("gzip JSON audit artifacts are deterministic, validated and corruptions fail closed", async (t) => {
  const root = await sandbox(t);
  const value = { supports: [{ id: "support-a", evidenceIds: ["evidence-a"] }], scope: "extraction_assignment" };
  const input = bundle({ artifacts: { "provenance.json.gz": value } });
  const a = await publishCandidateBundle(join(root, "first"), input);
  const b = await publishCandidateBundle(join(root, "second"), input);
  assert.equal(a.manifest.bundleId, b.manifest.bundleId);
  assert.deepEqual(await readFile(join(root, "first/provenance.json.gz")), await readFile(join(root, "second/provenance.json.gz")));
  assert.deepEqual((await verifyCandidateBundle(join(root, "first"))).artifacts["provenance.json.gz"], value);
  const supplied = await publishCandidateBundle(join(root, "third"), bundle({ artifacts: { "provenance.json.gz": gzipSync(Buffer.from(canonicalJson(value))) } }));
  assert.deepEqual(supplied.artifacts["provenance.json.gz"], value);
  await assert.rejects(publishCandidateBundle(join(root, "invalid"), bundle({ artifacts: { "provenance.json.gz": Buffer.from("not gzip") } })), /Invalid JSON/u);
  await assert.rejects(publishCandidateBundle(join(root, "reserved"), bundle({ artifacts: { "manifest.json.gz": value } })), /reserved/u);
  await writeFile(join(root, "first/provenance.json.gz"), Buffer.from("corrupt"));
  await assert.rejects(verifyCandidateBundle(join(root, "first")), /hash\/size mismatch/u);
});
