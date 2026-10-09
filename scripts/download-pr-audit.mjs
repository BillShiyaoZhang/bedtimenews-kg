// This entry point is executed only from the exact authenticated PR base.
import { execFileSync } from "node:child_process";
import { readFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateAcceptedReleaseStructure } from "./lib/accepted-release.mjs";
import { createSnapshotReadClient } from "./lib/audit-snapshot-http.mjs";
import { downloadAuditSnapshot } from "./lib/download-audit-snapshot.mjs";
try {
const must = (v) => { if (!v) throw new Error("Trusted PR audit download rejected"); };
const env=process.env, root=resolve(import.meta.dirname,".."), event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH));
const pr=event.pull_request;
must(env.GITHUB_EVENT_NAME === "pull_request" && /^[a-f0-9]{40}$/u.test(pr?.base.sha) && /^[a-f0-9]{40}$/u.test(pr?.head.sha));
const git=(...args)=>execFileSync("git",["--no-replace-objects","-c","core.hooksPath=/dev/null","-C",root,...args],{maxBuffer:1024*1024});
must(git("rev-parse","HEAD").toString().trim() === pr.base.sha && git("rev-parse","refs/remotes/origin/main").toString().trim() === pr.base.sha);
const baseBytes=git("show",`${pr.base.sha}:data/accepted-release.json`), headBytes=git("show",`${pr.head.sha}:data/accepted-release.json`);
if (headBytes.equals(baseBytes)) {
  await appendFile(env.GITHUB_OUTPUT,"verified=false\n");
} else {
  const policy=JSON.parse(await readFile(resolve(root,"audit-snapshots/policy.json")));
  must(env.GITHUB_REPOSITORY === policy.repository && pr.head.repo.full_name === policy.repository);
  const receipt=JSON.parse(headBytes); validateAcceptedReleaseStructure(receipt);
  must(receipt.mode === "migration" && receipt.predecessor.commit === pr.base.sha);
  const client=createSnapshotReadClient({repository:policy.repository,token:env.GH_TOKEN});
  const result=await downloadAuditSnapshot({client,policy,baseCommit:pr.base.sha,receipt:receipt.auditReceipt,outputDirectory:resolve(env.RUNNER_TEMP,"verified-pr-audit")});
  console.log(JSON.stringify(result)); await appendFile(env.GITHUB_OUTPUT,"verified=true\n");
}

} catch {
  console.error("Trusted audit operation failed; no automatic retry or acceptance occurred. Inspect retained operation evidence before another write.");
  process.exitCode = 1;
}
