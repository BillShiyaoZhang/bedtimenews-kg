import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validate } from "../scripts/lib/validate.mjs";

const root = new URL("../", import.meta.url);
const [kg, ontology] = await Promise.all([
  readJson(new URL("data/kg.json", root)),
  readJson(new URL("data/ontology.json", root)),
]);

test("curated knowledge graph passes schema and reference checks", () => {
  assert.deepEqual(validate(kg, ontology), []);
});

test("every event is traceable to a repository source", () => {
  const sources = new Map(kg.sources.map((source) => [source.id, source]));
  for (const event of kg.events) {
    assert.ok(event.sourceIds.length > 0, `${event.id} has no source`);
    for (const sourceId of event.sourceIds) {
      const source = sources.get(sourceId);
      assert.ok(source, `${event.id} references missing source ${sourceId}`);
      assert.match(source.repositoryPath, /\.md$/);
      assert.match(source.repositoryUrl, /^https:\/\/github\.com\//);
    }
  }
});

test("cross-event relations are evidence-backed and time-oriented", () => {
  const events = new Map(kg.events.map((event) => [event.id, event]));
  for (const relation of kg.eventRelations) {
    assert.ok(relation.evidence.length >= 12, `${relation.id} evidence is thin`);
    assert.ok(events.has(relation.from));
    assert.ok(events.has(relation.to));
    if (["precedes", "enables", "continues"].includes(relation.type)) {
      assert.ok(
        events.get(relation.from).date <= events.get(relation.to).date,
        `${relation.id} points backward in time`,
      );
    }
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
