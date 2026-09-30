import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAuthenticatedGitReader, verifyGitObject } from "../scripts/lib/git-object-integrity.mjs";
const objects = new Map();
function add(type, bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const oid = createHash("sha1").update(`${type} ${value.length}\0`).update(value).digest("hex");
  objects.set(oid, { type, bytes: value }); return oid;
}
function tree(entries) {
  return add("tree", Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]))));
}
const blob = add("blob", "test content\n");
const nested = tree([["100644", "hello.md", blob]]);
const top = tree([["40000", "data", nested], ["160000", "source", "a".repeat(40)]]);
const parent = add("commit", `tree ${top}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nInitial\n`);
const head = add("commit", `tree ${top}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 2 +0000\ncommitter Fixture <fixture@example.invalid> 2 +0000\n\nNext\n`);
const reader = () => createAuthenticatedGitReader(async (oid) => objects.get(oid));

test("Git object hashing matches the documented blob format and rejects unmatched identities", () => {
  assert.equal(blob, "d670460b4b4aece5915caf5c68d12f560a9fe3e4");
  assert.equal(verifyGitObject(blob, "blob", Buffer.from("test content\n")).toString(), "test content\n");
  assert.throws(() => verifyGitObject("0".repeat(40), "blob", Buffer.from("test content\n")), /pinned object ID/u);
  assert.throws(() => verifyGitObject(blob, "unknown", Buffer.alloc(0)), /invalid object/u);
});

test("authenticated reader follows exact commit/tree/blob links and treats gitlinks as external pointers", async () => {
  const value = reader();
  assert.deepEqual(await value.commit(head), { tree: top, parents: [parent] });
  const entry = await value.entry(head, "data/hello.md");
  assert.deepEqual(entry, { mode: "100644", type: "blob", oid: blob });
  assert.equal((await value.blob(entry.oid)).toString(), "test content\n");
  assert.equal((await value.entries(head)).get("source").type, "commit");
  assert.equal(await value.isAncestor(parent, head), true);
  assert.equal(await value.isAncestor(head, parent), false);
  assert.equal(await value.entry(head, "data/missing.md"), null);
});

test("authenticated reader returns independent byte copies and validates types and logical paths", async () => {
  const value = reader();
  const copy = await value.object(blob); copy.bytes.fill(0);
  assert.equal((await value.blob(blob)).toString(), "test content\n");
  await assert.rejects(value.commit(blob), /unexpected type/u);
  await assert.rejects(value.entry(head, "../hello.md"), /logical path/u);
  await assert.rejects(value.entry(head, "/data/hello.md"), /logical path/u);
  await assert.rejects(value.isAncestor(parent, head, 1), /budget/u);
});
