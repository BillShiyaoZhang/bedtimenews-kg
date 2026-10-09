// Trusted downloader only. No PR-supplied URL, mutation, redirect credential,
// package execution or unbounded response is accepted here.
import { sha256 } from "./candidate-bundle.mjs";

const must = (value) => { if (!value) throw new Error("Audit snapshot HTTP binding rejected"); };
async function bounded(response, limit) {
  const declared = response.headers.get("content-length");
  must(declared === null || (/^\d+$/u.test(declared) && Number(declared) <= limit));
  must(response.body);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; must(size <= limit); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createSnapshotReadClient({ repository, token, fetchImpl = fetch }) {
  must(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) && typeof token === "string" && token.length > 0);
  const origin = `https://api.github.com/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
  async function request(path, accept = headers.Accept) {
    must(/^\/(?:actions|git)\/[A-Za-z0-9_/?=&.-]+$/u.test(path) && !path.includes(".."));
    return fetchImpl(`${origin}${path}`, { method: "GET", redirect: "manual", headers: { ...headers, Accept: accept }, signal: AbortSignal.timeout(60_000) });
  }
  return Object.freeze({
    async api(path) {
      const response = await request(path); must(response.status === 200);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bounded(response, 4 * 1024 * 1024)));
    },
    async download(artifact, maximumArchiveBytes) {
      must(Number.isSafeInteger(artifact.id) && artifact.id > 0 && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
        && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= maximumArchiveBytes);
      const redirect = await request(`/actions/artifacts/${artifact.id}/zip`);
      must(redirect.status === 302);
      const url = new URL(redirect.headers.get("location"));
      // GitHub Actions artifacts use signed Azure blob URLs. Never forward
      // Authorization, and never follow an additional redirect.
      must(url.protocol === "https:" && !url.username && !url.password && !url.port
        && /^[a-z0-9-]+\.blob\.core\.windows\.net$/u.test(url.hostname));
      const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(120_000) });
      must(response.status === 200);
      const bytes = await bounded(response, artifact.size_in_bytes);
      must(bytes.length === artifact.size_in_bytes && `sha256:${sha256(bytes)}` === artifact.digest);
      return bytes;
    },
  });
}
