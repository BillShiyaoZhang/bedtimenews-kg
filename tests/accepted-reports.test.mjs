import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256 } from "../scripts/lib/candidate-bundle.mjs";
import { ACCEPTED_REPORT_PATHS, buildAcceptedReports } from "../scripts/lib/accepted-reports.mjs";

function fixture() {
  const ontology = { version: "fixture-1", entityTypes: [{ id: "topic" }], eventTypes: [{ id: "economy" }, { id: "other" }], facets: [{ id: "themes", entityTypes: ["topic"] }] };
  const kg = { schemaVersion: ontology.version, source: { newsDatasetSchemaVersion: "1.1.0", segmentationVersion: "1.4.0", extractionVersion: "4.1.0" },
    entities: [{ id: "t1", type: "topic" }], sources: [{ id: "s1" }], events: [
      { id: "e1", newsId: "n1", title: "one", type: "economy", sourceIds: ["s1"], entityIds: ["t1"] },
      { id: "e2", newsId: "n2", title: "two", type: "other", sourceIds: ["s1"], entityIds: [] },
    ] };
  const news = { generatedAt: "2026-01-01T00:00:00Z", segmentation: { version: "1.4.0" }, news: [{ id: "n1" }, { id: "n2" }],
    pages: [{ id: "s1", repositoryPath: "daily/a.md", segmentation: { strategy: "explicit", newsCount: 2, needsReview: false } }] };
  const lifecycle = { observedInventory: { "daily/a.md": "a" }, effectiveInventory: { "daily/a.md": "a" }, sourceStates: { "daily/old.md": { state: "deleted" } }, decisions: [{ path: "daily/old.md", action: "delete" }] };
  const diff = { graph: { summary: { added: 1, removed: 2, changed: 3 } }, news: { summary: { added: 1, removed: 0, changed: 0 } } };
  const artifacts = { "kg.json": kg, "news.json": news, "lifecycle.json.gz": lifecycle, "diff.json": diff };
  const candidateManifest = { bundleId: "b".repeat(64), inputs: { recipe: { archiveCommit: "c".repeat(40), generatedAt: news.generatedAt } }, artifacts: {} };
  for (const name of ["kg.json", "news.json", "diff.json"]) { const content = Buffer.from(`${canonicalJson(artifacts[name])}\n`); candidateManifest.artifacts[name] = { bytes: content.length, sha256: sha256(content) }; }
  return { candidateManifest, artifacts, previousKG: { events: [kg.events[0]] }, ontology };
}

test("accepted reports recompute coverage and global changes from current candidate", () => {
  const options = fixture(); const reports = buildAcceptedReports(options);
  assert.deepEqual([...reports.keys()], ACCEPTED_REPORT_PATHS);
  const coverage = JSON.parse(reports.get("data/review/ontology-candidates.json"));
  assert.equal(coverage.coverage.totalNews, 2); assert.equal(coverage.coverage.entityCoveragePercent, 50);
  assert.equal(coverage.coverage.eventTypeCoveragePercent, 50); assert.equal(coverage.currentIncrement.newNews, 1);
  assert.equal(coverage.currentIncrement.otherTypeNews, 1); assert.equal(coverage.currentIncrement.newNewsWithoutKnownEntities, 1);
  const segmentation = JSON.parse(reports.get("data/review/news-segmentation.json"));
  assert.equal(segmentation.summary.news, 2); assert.equal(segmentation.summary.multiNewsPages, 1);
  const upstream = JSON.parse(reports.get("data/review/upstream-changes.json"));
  assert.equal(upstream.materialization, "full-candidate"); assert.equal(upstream.graphDiff.removed, 2);
  assert.equal(upstream.source.withdrawnPaths, 1); assert.equal(upstream.epistemicScope, "extraction_assignment");
  assert.deepEqual(upstream.reviewedDecisions, options.artifacts["lifecycle.json.gz"].decisions);
  assert.equal(upstream.diffSha256, options.candidateManifest.artifacts["diff.json"].sha256);
});

test("accepted reports are deterministic and reject stale candidate inputs", () => {
  const options = fixture(); assert.deepEqual(buildAcceptedReports(options), buildAcceptedReports(options));
  for (const name of ["kg.json", "news.json", "diff.json"]) {
    const bad = fixture(); bad.artifacts[name].stale = true;
    assert.throws(() => buildAcceptedReports(bad), /artifact mismatch/u);
  }
  const bad = fixture(); bad.ontology.version = "other";
  assert.throws(() => buildAcceptedReports(bad), /ontology mismatch/u);
});
