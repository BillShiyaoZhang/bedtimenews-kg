import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint } from "../scripts/lib/accepted-git.mjs";
import { createFileReleaseJournal, syncAcceptedRelease, assertReleaseApproval, prepareMigrationPullRequest } from "../scripts/lib/release-sync.mjs";
import { previewAcceptedMigration } from "../scripts/lib/accepted-candidate.mjs";
import { rollbackReviewBinding } from "../scripts/lib/accepted-transition.mjs";
import { promoteAcceptedCommit } from "../scripts/lib/release-promotion.mjs";
import { createReleaseGitTransport } from "../scripts/lib/release-runtime.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const repository = "fixture/accepted-sync";
const execFile = promisify(execFileCallback);
const git = async (cwd, args) => (await execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const head = (cwd) => git(cwd, ["rev-parse", "HEAD"]);
const bytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const sourceText = (date) => `---\ntitle: 美国情况\npublished: true\ndateCreated: ${date}T00:00:00Z\n---\n\n美国介绍情况。\n`;
async function commit(root, args = ["."]) {
  await git(root, ["add", "--", ...args]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  return head(root);
}
function receiptFor(manifest, targetCommit, id) {
  const tag = `kg-audit-${manifest.bundleId}`;
  const files = { ...manifest.artifacts, "manifest.json": { bytes: bytes(manifest).length, sha256: sha256(bytes(manifest)) } };
  return { schemaVersion: 2, kind: "github-audit-readback", repository, bundleId: manifest.bundleId,
    manifestSha256: files["manifest.json"].sha256, targetCommit, tag, releaseId: id,
    releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`, githubImmutableAtReadback: false, visibilityAtReadback: "draft", readbackVerified: true,
    assets: Object.fromEntries(Object.entries(files).map(([name, binding], index) => [name, { ...binding, id: id * 100 + index, name: `${binding.sha256}-${name}`, url: `https://github.com/${repository}/releases/download/${tag}/${binding.sha256}-${name}` }])),
    rawSourceArchiveIncluded: false, sourceReplay: "Restoring accepted outputs does not guarantee raw upstream re-extraction; upstream Git history must be available separately." };
}
async function fixture(callback, count = 2) {
  const directory = await mkdtemp(resolve(tmpdir(), "release-sync-"));
  try {
    await cp(resolve(root, "scripts"), resolve(directory, "scripts"), { recursive: true });
    await cp(resolve(root, "app/lib"), resolve(directory, "app/lib"), { recursive: true });
    await mkdir(resolve(directory, "data/generated"), { recursive: true }); await mkdir(resolve(directory, "data/processed"));
    for (const name of ["ontology-source.json", "ontology.json", "extraction-patterns.json", "extraction-rules.json", "news-overrides.json"]) await cp(resolve(root, "data", name), resolve(directory, "data", name));
    const source = resolve(directory, "sources/bedtimenews-archive-contents"); await mkdir(resolve(source, "daily"), { recursive: true });
    const add = async (index) => { const date = new Date(Date.UTC(2026, 0, index)).toISOString().slice(0, 10); await writeFile(resolve(source, `daily/${date}.md`), sourceText(date)); };
    for (let index = 1; index <= count; index++) await add(index);
    await git(source, ["init", "-q"]); await commit(source);
    const environment = { ...process.env }; delete environment.KG_RELEASE_ACTIVATED;
    await execFile(process.execPath, ["scripts/update-kg.mjs", "--bootstrap", "--source", source, "--include", "daily"], { cwd: directory, env: environment });
    await writeFile(resolve(directory, ".gitignore"), "work/\n");
    await git(directory, ["init", "-q"]); await git(directory, ["remote", "add", "origin", `https://github.com/${repository}.git`]); await commit(directory);
    let remote = await head(directory); await git(directory, ["update-ref", "refs/remotes/origin/main", remote]);
    const journal = await createFileReleaseJournal(resolve(directory, "work/journal.json"), repository);
    const audit = new Map(); const calls = []; let validationFailure = false; let publishFailure = false; let pagesFailure = false; let pushUncertain = false; let unreadablePush = false;
    const store = {
      async stageBundle({ bundleDir, targetCommit }) {
        const manifest = JSON.parse(await readFile(resolve(bundleDir, "manifest.json"), "utf8"));
        assert.equal(await head(directory), targetCommit, "preaccept preparation never rewrites the proposed code checkout");
        const existing = audit.get(manifest.bundleId);
        if (existing) { assert.equal(existing.receipt.targetCommit, targetCommit); calls.push("stage"); return { ...existing.receipt, visibilityAtReadback: existing.published ? "published" : "draft" }; }
        const files = new Map(await Promise.all([...Object.keys(manifest.artifacts), "manifest.json"].map(async (name) => [name, await readFile(resolve(bundleDir, name))])));
        const receipt = receiptFor(manifest, targetCommit, audit.size + 1); audit.set(manifest.bundleId, { manifest, files, receipt, published: false }); calls.push("stage"); return receipt;
      },
      async verifyBundle({ bundleDir }) { const manifest = JSON.parse(await readFile(resolve(bundleDir, "manifest.json"), "utf8")); calls.push("verify-audit"); return audit.get(manifest.bundleId).receipt; },
      async readBundle({ receipt }) { const entry = audit.get(receipt.bundleId); assert.ok(entry); assert.deepEqual(receipt, entry.receipt); return { manifest: structuredClone(entry.manifest), files: new Map([...entry.files].map(([name, value]) => [name, Buffer.from(value)])) }; },
      async publishAcceptedBundle({ checkpoint }) {
        const snapshot = await readVerifiedAcceptedCheckpoint(checkpoint); assert.ok(snapshot.manifest); assert.equal(snapshot.commit, remote);
        const entry = audit.get(snapshot.manifest.candidateBundleId); assert.ok(entry); calls.push(entry.published ? "read-public" : "publish"); entry.published = true;
        if (publishFailure) { publishFailure = false; throw new Error("publication response lost"); }
        return { ...entry.receipt, visibilityAtReadback: "published" };
      },
    };
    const transport = {
      async fetchMain() { await git(directory, ["update-ref", "refs/remotes/origin/main", remote]); return remote; },
      async readMain() { if (unreadablePush) throw new Error("remote temporarily unreadable"); return remote; },
      async pushFastForward({ expectedBase, commit, force }) {
        assert.equal(force, false); assert.equal(expectedBase, remote); assert.equal((await journal.read()).promotion.status, "intent");
        remote = commit; calls.push("push"); if (pushUncertain) { unreadablePush = true; throw new Error("push response lost"); }
      },
    };
    const run = (options = {}) => syncAcceptedRelease({ root: directory, repository, approval: { activated: true, storageRepository: repository }, journal, transport, store,
      acquireSource: async ({ bootstrap }) => { calls.push(bootstrap ? "bootstrap-source" : "acquire-source"); return source; },
      validatePrepared: async ({ prepared, manifest }) => {
        calls.push("validate"); assert.equal((await git(directory, ["show", `${prepared.commit}:data/accepted-release.json`])).trim(), canonicalJson(manifest));
        assert.ok([...audit.values()].every((entry) => entry.published || entry.manifest.bundleId === manifest.candidateBundleId));
        assert.equal(audit.get(manifest.candidateBundleId).published, false);
        if (validationFailure) throw new Error("required validation failed");
      },
      reconcilePages: async ({ commit }) => { calls.push("pages"); assert.equal(commit, remote); if (pagesFailure) { pagesFailure = false; throw new Error("Pages unavailable"); } return { targetSha: commit, runId: 1 }; }, ...options });
    const checkout = () => git(directory, ["reset", "--hard", remote]);
    const preparePR = (options) => prepareMigrationPullRequest({ root: directory, repository, approval: { activated: true, storageRepository: repository }, journal, transport, store, source,
      validatePrepared: async ({ prepared, manifest }) => {
        calls.push("validate-pr"); assert.equal(await git(directory, ["show", `${prepared.commit}:data/accepted-release.json`]), canonicalJson(manifest));
        assert.equal(audit.get(manifest.candidateBundleId).published, false);
        if (validationFailure) throw new Error("required validation failed");
      }, ...options });
    await callback({ directory, source, add, run, checkout, journal, audit, calls, store, preparePR, transport, remote: () => remote,
      async load() { return loadAcceptedGitCheckpoint({ root: directory, repository, commit: remote }); },
      async acceptCode() { remote = await commit(directory); await git(directory, ["update-ref", "refs/remotes/origin/main", remote]); return remote; },
      async mergeReviewed(prepared) {
        await git(directory, ["checkout", "-B", "fixture-main", remote]);
        await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--no-ff", "--no-edit", prepared.commit]);
        remote = await head(directory); await git(directory, ["update-ref", "refs/remotes/origin/main", remote]); return remote;
      },
      failValidation() { validationFailure = true; }, failPublication() { publishFailure = true; }, failPages() { pagesFailure = true; },
      losePush() { pushUncertain = true; }, restoreRemote() { unreadablePush = false; } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("activation and repository-specific storage consent never default to approved", () => {
  for (const approval of [{}, { activated: true }, { activated: true, storageRepository: "other/repo" }]) assert.throws(() => assertReleaseApproval(approval, repository), /explicit activation/u);
});

test("end-to-end bootstrap and two updates fully remove old global-cap edges; noop reuses acceptance", async () => {
  await fixture(async ({ source, add, run, checkout, audit, calls, remote }) => {
    const first = await run(); assert.equal(first.status, "accepted"); await checkout();
    assert.equal([...audit.values()][0].manifest.versions.candidate, "3.0.0");
    for (const count of [90, 91]) { await add(count); await commit(source); assert.equal((await run()).status, "accepted"); await checkout(); }
    const entries = [...audit.values()];
    assert.deepEqual(entries.map((entry) => JSON.parse(entry.files.get("kg.json")).eventRelations.length), [88, 89, 0]);
    const accepted = remote(); const pushCount = calls.filter((call) => call === "push").length;
    await commit(source); const noop = await run();
    assert.equal(noop.status, "noop"); assert.equal(noop.acceptedCommit, accepted); assert.equal(audit.size, 3);
    assert.equal(calls.filter((call) => call === "push").length, pushCount);
    assert.ok(calls.indexOf("validate") < calls.indexOf("push") && calls.indexOf("push") < calls.indexOf("publish"));
  }, 89);
});

test("validation failure leaves accepted main and files unchanged and audit private", async () => {
  await fixture(async ({ directory, run, failValidation, audit, remote }) => {
    const before = remote(); const data = await readFile(resolve(directory, "data/generated/kg.json")); failValidation();
    await assert.rejects(run(), /required validation failed/u);
    assert.equal(remote(), before); assert.deepEqual(await readFile(resolve(directory, "data/generated/kg.json")), data);
    assert.equal([...audit.values()][0].published, false);
  });
});

for (const failure of ["publication", "pages", "push"]) {
  test(`${failure} failure after acceptance recovers without source acquisition or new data version`, async () => {
    await fixture(async (f) => {
      if (failure === "publication") f.failPublication(); if (failure === "pages") f.failPages(); if (failure === "push") f.losePush();
      await assert.rejects(f.run()); const accepted = f.remote(); f.restoreRemote();
      const beforeAcquisition = f.calls.filter((call) => call.includes("source")).length;
      const result = await f.run(); assert.equal(result.status, "recovered"); assert.equal(result.freshSourceReplay, false);
      assert.equal(result.acceptedCommit, accepted); assert.equal(f.audit.size, 1); assert.equal(f.calls.filter((call) => call === "push").length, 1);
      assert.equal(f.calls.filter((call) => call.includes("source")).length, beforeAcquisition);
    });
  });
}

test("legacy update, rebuild and bootstrap reject state4 before writing", async () => {
  await fixture(async ({ directory, run, checkout }) => {
    await run(); await checkout(); const before = await readFile(resolve(directory, "data/generated/kg.json"));
    for (const flag of [[], ["--rebuild"], ["--bootstrap"]]) await assert.rejects(execFile(process.execPath, ["scripts/update-kg.mjs", ...flag], { cwd: directory }), /legacy update\/rebuild\/bootstrap/u);
    await rm(resolve(directory, "data/accepted-release.json"));
    await assert.rejects(execFile(process.execPath, ["scripts/update-kg.mjs", "--rebuild"], { cwd: directory }), /legacy update\/rebuild\/bootstrap/u);
    assert.deepEqual(await readFile(resolve(directory, "data/generated/kg.json")), before);
  });
});

test("authenticated single-parent lease permits only an exact-base fast-forward", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "release-cas-"));
  try {
    const remote = resolve(directory, "remote.git"); const local = resolve(directory, "local");
    await mkdir(local); await git(directory, ["init", "--bare", "-q", remote]); await git(local, ["init", "-q"]);
    await writeFile(resolve(local, "one"), "one"); const base = await commit(local); await git(local, ["remote", "add", "origin", remote]); await git(local, ["push", "-q", "origin", `${base}:refs/heads/main`]);
    await writeFile(resolve(local, "one"), "two"); const prepared = await commit(local);
    const transport = createReleaseGitTransport(local, { repository, verifyOrigin: async ({ origin }) => origin === remote }); await transport.pushFastForward({ repository, ref: "refs/heads/main", expectedBase: base, commit: prepared, force: false });
    assert.equal(await transport.readMain(), prepared);
    await assert.rejects(transport.pushFastForward({ repository, ref: "refs/heads/other", expectedBase: prepared, commit: prepared, force: false }), /repository\/ref mismatch/u);
    await assert.rejects(transport.pushFastForward({ repository: "wrong/repo", ref: "refs/heads/main", expectedBase: prepared, commit: prepared, force: false }), /repository\/ref mismatch/u);
    await assert.rejects(transport.pushFastForward({ repository, ref: "refs/heads/main", expectedBase: base, commit: prepared, force: false }), /changed before push/u);
    await assert.rejects(transport.pushFastForward({ repository, ref: "refs/heads/main", expectedBase: prepared, commit: base, force: false }), /exactly the expected parent/u);
    await writeFile(resolve(local, "one"), "three"); const next = await commit(local);
    // Simulate movement after the separate read: the explicit lease must still
    // reject both a remote rewind (otherwise a plain push would succeed) and
    // an unrelated concurrent advance.
    transport.readMain = async () => prepared;
    await git(remote, ["update-ref", "refs/heads/main", base]);
    await assert.rejects(transport.pushFastForward({ repository, ref: "refs/heads/main", expectedBase: prepared, commit: next, force: false }), /Git push failed/u);
    assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), base);
    const tree = await git(local, ["rev-parse", `${next}^{tree}`]);
    const concurrent = await git(local, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-p", prepared, "-m", "concurrent"]);
    await git(local, ["push", "-q", "origin", `${concurrent}:refs/heads/main`]);
    await assert.rejects(transport.pushFastForward({ repository, ref: "refs/heads/main", expectedBase: prepared, commit: next, force: false }), /Git push failed/u);
    assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), concurrent);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("accepted output rendering and publication recovery work without raw sources and claim no replay", async () => {
  await fixture(async ({ directory, source, run, checkout, failPublication }) => {
    failPublication(); await assert.rejects(run(), /publication response lost/u); await checkout();
    await rm(source, { recursive: true, force: true });
    const recovered = await run({ recoverOnly: true }); assert.equal(recovered.freshSourceReplay, false);
    const { stdout } = await execFile(process.execPath, ["scripts/validate-accepted-release.mjs"], { cwd: directory });
    assert.match(stdout, /No fresh raw-source replay was performed/u);
    await assert.rejects(run(), /ENOENT|source root/u);
    const ontologyPath = resolve(directory, "data/ontology-source.json");
    await writeFile(ontologyPath, `${await readFile(ontologyPath, "utf8")}\n`);
    await assert.rejects(execFile(process.execPath, ["scripts/validate-accepted-release.mjs"], { cwd: directory }), /configuration differs.*explicit migration/u);
  });
});

test("bootstrap refuses newer source inventory instead of silently importing it", async () => {
  await fixture(async ({ source, add, run, remote, audit }) => {
    const before = remote(); await add(3); await commit(source);
    await assert.rejects(run(), /initial lifecycle baseline must exactly replay accepted source inventory/u);
    assert.equal(remote(), before); assert.equal(audit.size, 0);
  });
});

test("a main advance during validation leaves only a private unaccepted draft", async () => {
  await fixture(async ({ directory, run, audit, calls, remote }) => {
    const before = remote();
    await assert.rejects(run({ validatePrepared: async () => {
      const changed = await commit(directory); await git(directory, ["update-ref", "refs/remotes/origin/main", changed]);
    } }), /not the exact pinned|changed|differs/u);
    assert.equal(remote(), before); assert.equal(calls.includes("push"), false); assert.equal([...audit.values()][0].published, false);
  });
});

test("semantic migration is prepared as one coherent code+data PR, then merged before publication recovery", async () => {
  await fixture(async ({ directory, source, run, checkout, preparePR, mergeReviewed, load, store, audit, calls, remote, transport }) => {
    const seed = await run(); await checkout();
    await git(directory, ["checkout", "-b", "reviewed-semantic-change"]);
    const overridePath = resolve(directory, "data/news-overrides.json");
    const overrides = JSON.parse(await readFile(overridePath, "utf8")); overrides.version = "1.1.2";
    await writeFile(overridePath, JSON.stringify(overrides));
    const proposalCommit = await commit(directory); const proposalRef = "refs/heads/reviewed-semantic-change";
    const preview = await previewAcceptedMigration(directory, { checkpoint: await load(), store, source, proposalCommit });
    const migrationReview = "work/migration-review.json";
    await writeFile(resolve(directory, migrationReview), bytes({ ...preview.reviewBinding, reviewedAt: "2026-01-03T00:00:00Z", reason: "Review fixture semantic version and full deterministic diff" }));
    await assert.rejects(run({ candidateOptions: { migrationReview } }), /coherent prepare-migration-pr/u);
    assert.equal(audit.size, 1);
    const callsBefore = calls.length;
    const result = await preparePR({ proposalCommit, proposalRef, migrationReview });
    assert.equal(result.status, "prepared-for-review"); assert.equal(result.accepted, false); assert.equal(result.requiresReviewedMerge, true);
    assert.equal(remote(), seed.acceptedCommit); assert.equal(await head(directory), proposalCommit);
    assert.equal(await git(directory, ["rev-parse", proposalRef]), proposalCommit);
    assert.deepEqual(calls.slice(callsBefore), ["stage", "validate-pr", "verify-audit"]);
    assert.equal(audit.get(result.bundleId).published, false);
    assert.equal(await git(directory, ["rev-list", "--parents", "-n", "1", result.prepared.commit]), `${result.prepared.commit} ${proposalCommit}`);
    await assert.rejects(promoteAcceptedCommit({ prepared: result.prepared, transport }), /preparation|authority/u);
    const merged = await mergeReviewed(result.prepared);
    const recovered = await run({ recoverOnly: true }); assert.equal(recovered.status, "recovered"); assert.equal(recovered.acceptedCommit, merged);
    assert.equal(audit.get(result.bundleId).published, true); assert.equal(audit.size, 2);
    const receipt = JSON.parse(await readFile(resolve(directory, "data/accepted-release.json"), "utf8"));
    assert.equal(receipt.mode, "migration"); assert.equal(receipt.codeCommit, proposalCommit); assert.equal(receipt.predecessor.releaseId, seed.releaseId);
    assert.equal((await run()).status, "noop");
  });
});

test("forward rollback restores exact target outputs without source access and preserves later identities", async () => {
  await fixture(async ({ directory, source, add, run, checkout, load, audit, calls }) => {
    const first = await run(); await checkout();
    const target = await readVerifiedAcceptedCheckpoint(await load());
    const targetKG = await readFile(resolve(directory, "data/generated/kg.json"));
    const targetNews = await readFile(resolve(directory, "data/processed/news.json"));
    await add(3); await commit(source); await run(); await checkout();
    const current = await readVerifiedAcceptedCheckpoint(await load());
    const review = "work/rollback-review.json";
    await writeFile(resolve(directory, review), bytes({ ...rollbackReviewBinding(current, target), reviewedAt: "2026-01-03T00:00:00Z", reason: "Restore the exact reviewed first accepted materialization" }));
    const acquisitions = calls.filter((item) => item.includes("source")).length;
    await rm(source, { recursive: true, force: true });
    const restored = await run({ operation: "rollback", rollbackCommit: first.acceptedCommit, rollbackReview: review });
    assert.equal(restored.status, "accepted"); assert.equal(restored.freshSourceReplay, false); await checkout();
    assert.deepEqual(await readFile(resolve(directory, "data/generated/kg.json")), targetKG);
    assert.deepEqual(await readFile(resolve(directory, "data/processed/news.json")), targetNews);
    const release = JSON.parse(await readFile(resolve(directory, "data/accepted-release.json"), "utf8"));
    assert.equal(release.mode, "rollback"); assert.equal(release.rollbackTarget.commit, first.acceptedCommit);
    assert.equal(release.transition.freshSourceReplay, false);
    const { gunzipSync } = await import("node:zlib");
    const lifecycle = JSON.parse(gunzipSync(audit.get(restored.bundleId).files.get("lifecycle.json.gz")));
    assert.equal(lifecycle.sourceStates["daily/2026-01-03.md"].status, "deleted");
    assert.equal(lifecycle.states.news.length, 3); assert.equal(lifecycle.states.news.filter((row) => row.state === "dormant").length, 1);
    assert.equal(calls.filter((item) => item.includes("source")).length, acquisitions);
  });
});

test("migration PR rejects dirty code before staging and fails closed on validation or proposal movement", async () => {
  await fixture(async ({ directory, source, run, checkout, preparePR, load, store, audit, remote }) => {
    const first = await run(); await checkout(); await git(directory, ["checkout", "-b", "guarded-semantic-change"]);
    const overridePath = resolve(directory, "data/news-overrides.json");
    const overrides = JSON.parse(await readFile(overridePath, "utf8")); overrides.version = "1.1.2";
    await writeFile(overridePath, JSON.stringify(overrides)); const proposalCommit = await commit(directory);
    const proposalRef = "refs/heads/guarded-semantic-change";
    const preview = await previewAcceptedMigration(directory, { checkpoint: await load(), store, source, proposalCommit });
    const migrationReview = "work/migration-review.json";
    await writeFile(resolve(directory, migrationReview), bytes({ ...preview.reviewBinding, reviewedAt: "2026-01-03T00:00:00Z", reason: "Review complete fixture semantic migration" }));
    const options = { proposalCommit, proposalRef, migrationReview };
    await writeFile(overridePath, `${JSON.stringify(overrides)}\n`);
    await assert.rejects(preparePR(options), /clean|dirty|tracked/u); assert.equal(audit.size, 1);
    await git(directory, ["checkout", "--", "data/news-overrides.json"]);
    await assert.rejects(preparePR({ ...options, validatePrepared: async () => { throw new Error("required validation failed"); } }), /required validation failed/u);
    assert.equal(remote(), first.acceptedCommit); assert.equal(await head(directory), proposalCommit);
    assert.equal([...audit.values()].at(-1).published, false);
    await assert.rejects(preparePR({ ...options, validatePrepared: async () => { await commit(directory); } }), /proposal branch|checkout differs/u);
    assert.equal(remote(), first.acceptedCommit); assert.equal(audit.size, 2); assert.equal([...audit.values()].at(-1).published, false);
  });
});

test("accepted rendering rejects a changed HEAD gitlink even with unchanged receipt and outputs", async () => {
  await fixture(async ({ directory, source, run, checkout }) => {
    await run(); await checkout();
    await commit(source); await commit(directory);
    await assert.rejects(execFile(process.execPath, ["scripts/validate-accepted-release.mjs"], { cwd: directory }), /source gitlink differs/u);
  });
});
