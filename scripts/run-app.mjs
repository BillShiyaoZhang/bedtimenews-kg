import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const [command, ...extra] = process.argv.slice(2);
if (!["dev", "build", "pages", "start"].includes(command)) throw new Error("Use dev, build, pages or start");
process.env.WRANGLER_LOG_PATH ??= ".wrangler/wrangler.log";
const pages = command === "pages";
if (pages) process.env.NEXT_OUTPUT_EXPORT = "1";
const workerConfig = resolve("dist/server/wrangler.json");
const localWorker = command === "start" && existsSync(workerConfig);
const name = localWorker ? "wrangler" : pages ? "next" : "vinext";
const pkg = JSON.parse(await readFile(resolve("node_modules", name, "package.json"), "utf8"));
const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[name];
let invocation = [pages ? "build" : command, ...extra];
// Windows Turbopack can time out while exchanging PostCSS worker messages.
// Keep an explicit bundler choice and use the supported production Webpack path.
if (pages && process.platform === "win32" && !extra.some((arg) => ["--webpack", "--turbopack", "--turbo"].includes(arg))) invocation.splice(1, 0, "--webpack");
if (localWorker) {
  // Cloudflare output must run with its generated assets binding. vinext's
  // Node static-file cache uses native Windows separators for URL keys.
  const flags = extra.map((arg) => arg === "--hostname" || arg === "-H" ? "--ip" : arg === "-p" ? "--port" : arg.replace(/^--hostname=/u, "--ip="));
  const hasPort = flags.some((arg) => ["--port", "-p"].includes(arg) || arg.startsWith("--port="));
  const hasHost = flags.some((arg) => arg === "--ip" || arg.startsWith("--ip="));
  invocation = ["dev", "--config", workerConfig, "--local", ...(!hasPort ? ["--port", process.env.PORT ?? "3000"] : []), ...(!hasHost ? ["--ip", "127.0.0.1"] : []), ...flags];
}
const args = [resolve("node_modules", name, bin), ...invocation];
const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
