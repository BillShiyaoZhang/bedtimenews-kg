import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readNewsFragment } from "./news.mjs";

export function validateSourceRevisions(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.revisions)) {
    throw new Error("Source revision manifest must have schemaVersion 1 and revisions[].");
  }
  const ids = new Set();
  const transitions = new Set();
  for (const revision of manifest.revisions) {
    const path = revision.path;
    if (
      typeof path !== "string" ||
      !/^(main|daily|reference|opinion|business|commercial|livestream|shorts)\/.+\.md$/u.test(path) ||
      /[\\:\0]/u.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Source revision path must be a relative content Markdown path.");
    }
    if (
      typeof revision.id !== "string" || !revision.id.trim() || ids.has(revision.id) ||
      !/^[a-f0-9]{64}$/u.test(revision.fromHash ?? "") ||
      !/^[a-f0-9]{64}$/u.test(revision.toHash ?? "") ||
      revision.fromHash === revision.toHash ||
      !/^[a-f0-9]{40}$/u.test(revision.upstreamCommit ?? "") ||
      !["preserve_news", "navigation_only"].includes(revision.kind) ||
      typeof revision.reason !== "string" || !revision.reason.trim() ||
      !/^\d{4}-\d{2}-\d{2}T/u.test(revision.reviewedAt ?? "") ||
      !Number.isFinite(Date.parse(revision.reviewedAt))
    ) {
      throw new Error(`Invalid or duplicate source revision: ${path}.`);
    }
    const transition = `${path}:${revision.fromHash}:${revision.toHash}`;
    if (transitions.has(transition)) {
      throw new Error(`Duplicate source revision transition: ${path}.`);
    }
    ids.add(revision.id);
    transitions.add(transition);
  }
}

// A review approves exact file bytes, never arbitrary later edits. Existing news
// records and every page field other than the full-file hash must remain equal.
export async function applyReviewedSourceRevisions({
  manifest,
  changes,
  dataset,
  kg,
  candidateDataset,
  sourceRoot,
}) {
  validateSourceRevisions(manifest);
  const existingPages = new Map(dataset.pages.map((page) => [page.repositoryPath, page]));
  const currentPages = new Map(candidateDataset.pages.map((page) => [page.repositoryPath, page]));
  const sources = new Map(kg.sources.map((page) => [page.repositoryPath, page]));
  const replacements = new Map();
  const applied = [];
  const pending = [];
  for (const change of changes.modified) {
    const revision = manifest.revisions.find((entry) =>
      entry.path === change.path &&
      entry.fromHash === change.acceptedHash &&
      entry.toHash === change.currentHash,
    );
    if (!revision) {
      pending.push(change);
      continue;
    }
    const bytes = await readFile(resolve(sourceRoot, revision.path));
    if (createHash("sha256").update(bytes).digest("hex") !== revision.toHash) {
      throw new Error(`Reviewed source bytes changed during update: ${revision.path}.`);
    }
    const previous = existingPages.get(revision.path);
    const current = currentPages.get(revision.path);
    if (revision.kind === "navigation_only") {
      if (previous || current || sources.has(revision.path)) {
        throw new Error(`Navigation review cannot change a referenced page: ${revision.path}.`);
      }
    } else {
      if (
        !previous || !current ||
        previous.contentHash !== revision.fromHash ||
        current.contentHash !== revision.toHash ||
        !isDeepStrictEqual(previous, sources.get(revision.path)) ||
        !isDeepStrictEqual({ ...previous, contentHash: revision.toHash }, current)
      ) {
        throw new Error(`Source review would change page metadata: ${revision.path}.`);
      }
      const byId = (left, right) => left.id.localeCompare(right.id);
      const oldNews = dataset.news.filter((item) => item.pageId === previous.id).sort(byId);
      const newNews = candidateDataset.news.filter((item) => item.pageId === current.id).sort(byId);
      if (!oldNews.length || !isDeepStrictEqual(oldNews, newNews)) {
        throw new Error(`Source review would change accepted news or boundaries: ${revision.path}.`);
      }
      for (const item of oldNews) readNewsFragment(bytes.toString("utf8"), item.fragment);
      replacements.set(previous.id, { ...previous, contentHash: revision.toHash });
    }
    applied.push(revision);
  }
  return {
    dataset: { ...dataset, pages: dataset.pages.map((page) => replacements.get(page.id) ?? page) },
    kg: { ...kg, sources: kg.sources.map((page) => replacements.get(page.id) ?? page) },
    changes: { ...changes, modified: pending },
    applied,
    updatedPageCount: replacements.size,
  };
}
