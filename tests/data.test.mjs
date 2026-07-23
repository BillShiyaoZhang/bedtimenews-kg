import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validate } from "../scripts/lib/validate.mjs";

const root = new URL("../", import.meta.url);
const [kg, ontology, coverageReport] = await Promise.all([
  readJson(new URL("data/generated/kg.json", root)),
  readJson(new URL("data/ontology.json", root)),
  readJson(new URL("data/review/ontology-candidates.json", root)),
]);

test("generated semantic knowledge graph passes schema and reference checks", () => {
  assert.deepEqual(validate(kg, ontology), []);
  assert.ok(kg.sources.length > 2_000);
  assert.ok(kg.events.length > 6_000);
  assert.ok(kg.entities.length > 1_500);
  assert.equal(kg.schemaVersion, ontology.version);
  assert.equal(kg.source.extractionVersion, "2.0.0");
});

test("ontology exposes the homepage search facets", () => {
  const facets = new Map(ontology.facets.map((facet) => [facet.id, facet]));
  for (const id of ["event", "subject", "place", "topic", "named_object"]) {
    assert.ok(facets.has(id), `missing ${id} facet`);
  }
  assert.deepEqual(facets.get("subject").entityTypes, [
    "person",
    "organization",
  ]);
  assert.deepEqual(facets.get("place").entityTypes, ["place"]);
});

test("semantic coverage remains above reviewed thresholds", () => {
  assert.ok(coverageReport.coverage.entityCoveragePercent >= 98);
  assert.ok(coverageReport.coverage.eventTypeCoveragePercent >= 80);
  assert.ok(coverageReport.coverage.facetCoverage.place.percent >= 80);
  assert.ok(coverageReport.coverage.facetCoverage.topic.percent >= 90);
  assert.ok(coverageReport.coverage.facetCoverage.subject.percent >= 30);
});

test("every event is traceable to a repository source", () => {
  const sources = new Map(kg.sources.map((source) => [source.id, source]));
  for (const event of kg.events) {
    assert.ok(event.sourceIds.length > 0, `${event.id} has no source`);
    for (const sourceId of event.sourceIds) {
      const source = sources.get(sourceId);
      assert.ok(source, `${event.id} references missing source ${sourceId}`);
      assert.match(source.repositoryPath, /\.md$/u);
      assert.match(source.repositoryUrl, /^https:\/\/github\.com\//u);
    }
  }
});

test("automated event relations are evidence-backed and time-oriented", () => {
  const events = new Map(kg.events.map((event) => [event.id, event]));
  const entities = new Set(kg.entities.map((entity) => entity.id));
  for (const relation of kg.eventRelations) {
    assert.equal(relation.type, "precedes");
    assert.ok(relation.evidence.length >= 20, `${relation.id} evidence is thin`);
    assert.ok(entities.has(relation.viaEntityId));
    assert.ok(events.has(relation.from));
    assert.ok(events.has(relation.to));
    assert.ok(
      events.get(relation.from).date <= events.get(relation.to).date,
      `${relation.id} points backward in time`,
    );
  }
});

test("ontology relation types document their domain and range", () => {
  for (const relation of ontology.relationTypes) {
    assert.ok(relation.description.length >= 8);
    assert.ok(relation.from.length > 0);
    assert.ok(relation.to.length > 0);
    assert.equal(typeof relation.directed, "boolean");
  }
});

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}
