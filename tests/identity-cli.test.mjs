import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const execFile = promisify(callback);
const root = fileURLToPath(new URL("..", import.meta.url));

test("ordinary legacy sync refuses reviewed identities before compiling or changing accepted data", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "identity-legacy-gate-"));
  try {
    await cp(resolve(root, "scripts"), resolve(directory, "scripts"), { recursive: true });
    await cp(resolve(root, "app/lib"), resolve(directory, "app/lib"), { recursive: true });
    await mkdir(resolve(directory, "data/generated"), { recursive: true });
    const original = '{"schemaVersion":3}\n';
    await writeFile(resolve(directory, "data/archive-state.json"), original);
    await writeFile(resolve(directory, "data/generated/kg.json"), "accepted bytes stay unchanged\n");
    await writeFile(resolve(directory, "data/entity-identities.json"), JSON.stringify({ schemaVersion: 1, scope: "news_scoped_extraction_assignment", identities: [{ id: "identity-reviewed", type: "person", label: "Reviewed subject", status: "active", reason: "Explicit review", reviewedAt: "2026-01-01T00:00:00Z" }], assignments: [] }));
    const env = { ...process.env }; delete env.KG_RELEASE_ACTIVATED;
    for (const args of [[], ["--rebuild"], ["--bootstrap"]]) await assert.rejects(execFile(process.execPath, ["scripts/update-kg.mjs", ...args], { cwd: directory, env }), (error) => /Reviewed entity identities require full accepted candidate replay/u.test(error.stderr));
    assert.equal(await readFile(resolve(directory, "data/archive-state.json"), "utf8"), original);
    assert.equal(await readFile(resolve(directory, "data/generated/kg.json"), "utf8"), "accepted bytes stay unchanged\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
