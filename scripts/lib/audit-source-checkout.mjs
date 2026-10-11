// Trusted operator code. Runs before npm ci, only in the credential-free container.
// Never use proposal-controlled .gitmodules as a clone destination or URL.
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export const AUDIT_SOURCE_PATH = "sources/bedtimenews-archive-contents";
export const AUDIT_SOURCE_URL = "https://github.com/bedtimenews/bedtimenews-archive-contents.git";
const commit = /^[a-f0-9]{40}$/u;
const must = (v) => { if (!v) throw new Error("Audit source checkout binding rejected"); };
const defaultRun = (args) => execFileSync("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
function preflight(root, plan, run, env) {
  must(!env.GH_TOKEN && !env.GITHUB_TOKEN && !env.ACTIONS_RUNTIME_TOKEN && !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  must([plan.proposalCommit, plan.expectedMain, plan.sourceCommit].every((value) => commit.test(value ?? "")));
  const git = (...args) => run(["-C", root, ...args]);
  must(git("rev-parse", "HEAD") === plan.proposalCommit && git("rev-parse", "refs/remotes/origin/main") === plan.expectedMain);
  const original = git("ls-tree", plan.proposalCommit, "--", AUDIT_SOURCE_PATH);
  must(new RegExp(`^160000 commit [a-f0-9]{40}\\t${AUDIT_SOURCE_PATH}$`, "u").test(original));
  must(git("config", "--blob", `${plan.proposalCommit}:.gitmodules`, "--get", `submodule.${AUDIT_SOURCE_PATH}.path`) === AUDIT_SOURCE_PATH);
  must(git("config", "--blob", `${plan.proposalCommit}:.gitmodules`, "--get", `submodule.${AUDIT_SOURCE_PATH}.url`) === AUDIT_SOURCE_URL);
}
export function verifyAuditSourceCheckout({ root, plan, run = defaultRun, env = process.env }) {
  preflight(root, plan, run, env);
  const source = resolve(root, AUDIT_SOURCE_PATH);
  must(run(["-C", source, "remote", "get-url", "origin"]) === AUDIT_SOURCE_URL);
  must(run(["-C", source, "rev-parse", "HEAD"]) === plan.sourceCommit);
  must(run(["-C", source, "cat-file", "-t", plan.sourceCommit]) === "commit");
  must(run(["-C", source, "status", "--porcelain", "--untracked-files=all"]) === "");
}
export async function checkoutAuditSource({ root, plan, run = defaultRun, env = process.env }) {
  root = resolve(root);
  preflight(root, plan, run, env);
  // Refuse symlinks: even an untrusted proposal must not redirect the destination.
  for (const path of [resolve(root, "sources"), resolve(root, AUDIT_SOURCE_PATH)]) {
    const stat = await lstat(path).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    must(stat === null || stat.isDirectory());
  }
  const source = resolve(root, AUDIT_SOURCE_PATH);
  run(["clone", "--no-checkout", "--", AUDIT_SOURCE_URL, source]);
  run(["-C", source, "checkout", "--detach", plan.sourceCommit]);
  verifyAuditSourceCheckout({ root, plan, run, env });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkoutAuditSource({ root: process.argv[2], plan: JSON.parse(await readFile("/approved/plan.json")) });
}
