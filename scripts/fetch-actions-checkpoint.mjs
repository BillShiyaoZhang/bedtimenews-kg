// Trusted operator only, before any proposal/npm code. Receives a read-only
// job token; writes only the seven verified history data files for the container.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadAcceptedGitCheckpoint, readVerifiedAcceptedCheckpoint } from "./lib/accepted-git.mjs";
import { createGitHubReleaseStore } from "./lib/release-store.mjs";
import { createOfflineCheckpointStore } from "./lib/offline-checkpoint-store.mjs";

const root = resolve(import.meta.dirname, "..");
const scope = JSON.parse(await readFile(`${root}/audit-recovery/stage-h/scope.json`));
const directory = resolve(process.argv[2]);
const checkpoint = await loadAcceptedGitCheckpoint({ root, repository: scope.repository, commit: scope.expectedMain });
const verified = await readVerifiedAcceptedCheckpoint(checkpoint);
const [owner, repo] = scope.repository.split("/");
const store = createGitHubReleaseStore({ owner, repo, token: process.env.GH_TOKEN, fetchImpl: (url, options = {}) => {
  if (!["GET", "HEAD"].includes(options.method ?? "GET")) throw new Error("Checkpoint fetch is read-only");
  return fetch(url, options);
} });
try {
  const downloaded = await store.readBundle({ receipt: verified.manifest.auditReceipt });
  await mkdir(directory); // Never overwrite an earlier attempt's data.
  for (const [name, bytes] of downloaded.files) await writeFile(resolve(directory, name), bytes, { flag: "wx" });
  await createOfflineCheckpointStore({ directory, receipt: verified.manifest.auditReceipt }).readBundle({ receipt: verified.manifest.auditReceipt });
  console.log("Downloaded and verified seven historical assets against exact accepted Git checkpoint");
} catch (error) {
  console.error(JSON.stringify({ status: "checkpoint-read-failed", code: error.code ?? "VERIFICATION_FAILED", statusCode: error.status ?? null }));
  process.exitCode = 1;
}
