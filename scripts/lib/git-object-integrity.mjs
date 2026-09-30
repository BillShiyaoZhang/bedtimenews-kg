import { createHash } from "node:crypto";

const OID = /^[a-f0-9]{40}$/u;
const must = (value, message) => { if (!value) throw new Error(`Git object integrity: ${message}`); };
const decode = (value) => new TextDecoder("utf-8", { fatal: true }).decode(value);

/** Git hashes the type/byte-length/NUL header followed by exact object bytes. */
export function verifyGitObject(oid, type, content) {
  must(OID.test(oid ?? "") && ["commit", "tree", "blob", "tag"].includes(type) && Buffer.isBuffer(content), "invalid object request");
  const actual = createHash("sha1").update(`${type} ${content.length}\0`).update(content).digest("hex");
  must(actual === oid, "object bytes do not match their pinned object ID");
  return content;
}

function parseTree(content) {
  const entries = new Map(); let offset = 0;
  while (offset < content.length) {
    const end = content.indexOf(0, offset);
    must(end > offset && end + 21 <= content.length, "incomplete tree record");
    const header = decode(content.subarray(offset, end));
    const match = /^(40000|100644|100755|120000|160000) ([^/\x00]+)$/u.exec(header);
    must(match && ![".", ".."].includes(match[2]) && !entries.has(match[2]), "invalid or duplicate tree entry");
    const mode = match[1] === "40000" ? "040000" : match[1];
    entries.set(match[2], { mode, type: mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob", oid: content.subarray(end + 1, end + 21).toString("hex") });
    offset = end + 21;
  }
  return entries;
}

/** A short-lived reader authenticates each object on the commit→tree→blob path. */
export function createAuthenticatedGitReader(readObject) {
  must(typeof readObject === "function", "object reader required");
  const cache = new Map();
  async function object(oid, expectedType) {
    must(OID.test(oid ?? ""), "full SHA-1 object ID required");
    if (!cache.has(oid)) {
      const value = await readObject(oid);
      must(value && typeof value.type === "string" && Buffer.isBuffer(value.bytes), "reader returned invalid object");
      verifyGitObject(oid, value.type, value.bytes);
      cache.set(oid, { type: value.type, bytes: Buffer.from(value.bytes) });
    }
    const value = cache.get(oid);
    must(!expectedType || value.type === expectedType, "object has unexpected type");
    return value;
  }
  async function commit(oid) {
    const value = await object(oid, "commit");
    const headers = decode(value.bytes).split("\n\n", 1)[0].split("\n");
    const trees = headers.filter((line) => line.startsWith("tree ")).map((line) => line.slice(5));
    const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
    must(trees.length === 1 && OID.test(trees[0]) && parents.every((id) => OID.test(id)), "invalid commit tree/parent headers");
    return { tree: trees[0], parents };
  }
  async function tree(oid) { return parseTree((await object(oid, "tree")).bytes); }
  async function entry(commitId, path) {
    must(typeof path === "string" && path.length > 0 && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== ".."), "invalid logical path");
    const parts = path.split("/"); let treeId = (await commit(commitId)).tree;
    for (let index = 0; index < parts.length; index += 1) {
      const row = (await tree(treeId)).get(parts[index]);
      if (!row) return null;
      if (index === parts.length - 1) return { ...row };
      must(row.type === "tree", "non-directory path ancestor"); treeId = row.oid;
    }
    return null;
  }
  async function entries(oid) {
    const start = await object(oid);
    const root = start.type === "commit" ? (await commit(oid)).tree : oid;
    must(start.type === "commit" || start.type === "tree", "tree or commit required");
    const result = new Map(); const visiting = new Set();
    async function walk(id, prefix) {
      must(!visiting.has(id), "cyclic tree"); visiting.add(id);
      for (const [name, row] of await tree(id)) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (row.type === "tree") await walk(row.oid, path);
        else result.set(path, { ...row });
      }
      visiting.delete(id);
    }
    await walk(root, ""); return result;
  }
  async function blob(oid) { return Buffer.from((await object(oid, "blob")).bytes); }
  async function isAncestor(older, newer, limit = 100000) {
    must(OID.test(older ?? "") && OID.test(newer ?? ""), "full ancestor commits required");
    const pending = [newer]; const visited = new Set();
    while (pending.length) {
      const id = pending.pop(); if (visited.has(id)) continue;
      must(visited.size < limit, "commit ancestry budget exceeded"); visited.add(id);
      const value = await commit(id);
      if (id === older) return true;
      pending.push(...value.parents);
    }
    return false;
  }
  return Object.freeze({ object: async (oid, type) => { const value = await object(oid, type); return { type: value.type, bytes: Buffer.from(value.bytes) }; }, commit, entry, entries, blob, isAncestor });
}
