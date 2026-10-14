import { mkdir, writeFile, realpath, lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { getReadingData, getNewsArticle, getEntityArticle } from "../app/lib/reading-data.mjs";

const data = await getReadingData();
const publicRoot = resolve("public");
if (await realpath(publicRoot) !== publicRoot) throw new Error("Reading asset parent must be the workspace public directory");
const ownedRoot = resolve(publicRoot, "reading");
try { if ((await lstat(ownedRoot)).isSymbolicLink()) throw new Error("Reading output cannot be a symlink"); } catch (error) { if (error.code !== "ENOENT") throw error; }
// Replace only this generator's verified workspace directory; stale content
// from older or preview releases must not survive a current publication.
if (ownedRoot !== resolve(process.cwd(), "public/reading")) throw new Error("Unexpected reading asset target");
await rm(ownedRoot, { recursive: true, force: true });
const root = resolve("public/reading", data.catalog.releaseId);
await Promise.all([mkdir(resolve(root, "news"), { recursive: true }), mkdir(resolve(root, "entities"), { recursive: true })]);
await writeFile(resolve(root, "catalog.json"), JSON.stringify(data.catalog));
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const basePath = process.env.PAGES_BASE_PATH ?? (process.env.GITHUB_ACTIONS === "true" && repositoryName ? `/${repositoryName}` : "");
const manifest = { releaseId: data.catalog.releaseId, catalogUrl: `${basePath}/reading/${data.catalog.releaseId}/catalog.json`, updateIndex: data.catalog.recorded ? { ...data.catalog.updates, recorded: true } : null };
await writeFile(resolve("app/lib/reading-manifest.generated.json"), JSON.stringify(manifest));
async function batch(ids, folder, read) {
  for (let start = 0; start < ids.length; start += 40) {
    await Promise.all(ids.slice(start, start + 40).map(async (id) => {
      if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error("Unsafe reading asset ID");
      await writeFile(resolve(root, folder, `${id}.json`), JSON.stringify(await read(id)));
    }));
  }
}
await batch([...data.events.keys()], "news", getNewsArticle);
await batch([...data.entities.keys()], "entities", getEntityArticle);
console.log(`Reading assets: ${data.events.size} news, ${data.entities.size} entities (${data.catalog.recorded ? "verified content" : "legacy summaries"})`);
