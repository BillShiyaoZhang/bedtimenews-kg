import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  validateKnowledgeBaseNewsProjection,
  validateNewsDataset,
} from "../scripts/lib/news.mjs";
import { validate } from "../scripts/lib/validate.mjs";

const root = new URL("../", import.meta.url);
const [kg, ontology, newsDataset, coverageReport] = await Promise.all([
  readJson(new URL("data/generated/kg.json", root)),
  readJson(new URL("data/ontology.json", root)),
  readJson(new URL("data/processed/news.json", root)),
  readJson(new URL("data/review/ontology-candidates.json", root)),
]);

test("generated semantic knowledge graph passes schema and reference checks", () => {
  assert.deepEqual(validate(kg, ontology), []);
  assert.deepEqual(validateNewsDataset(newsDataset), []);
  assert.deepEqual(
    validateKnowledgeBaseNewsProjection(kg, newsDataset),
    [],
  );
  assert.ok(kg.sources.length > 2_000);
  assert.ok(kg.events.length > 8_500);
  assert.ok(kg.entities.length > 1_500);
  assert.equal(kg.schemaVersion, ontology.version);
  assert.equal(kg.source.newsDatasetSchemaVersion, "1.1.0");
  assert.equal(kg.source.segmentationVersion, "1.3.0");
  assert.equal(kg.source.extractionVersion, "2.1.0");
});

test("processed dataset splits multi-news pages before KG extraction", () => {
  const pagesByPath = new Map(
    newsDataset.pages.map((page) => [page.repositoryPath, page]),
  );
  const episode = pagesByPath.get("main/1-100/1.md");
  const reference = pagesByPath.get("reference/1-100/1.md");

  assert.equal(episode.segmentation.newsCount, 4);
  assert.equal(episode.publishedAt, "2019-07-12");
  assert.equal(reference.segmentation.newsCount, 10);
  assert.equal(reference.publishedAt, "2022-11-02");
  assert.equal(
    newsDataset.news.filter((item) => item.pageId === episode.id).length,
    4,
  );
  assert.deepEqual(
    [
      ...new Set(
        newsDataset.news
          .filter((item) => item.pageId === episode.id)
          .map((item) => item.date),
      ),
    ],
    ["2019-07-12"],
  );
  assert.equal(
    newsDataset.news.filter((item) => item.pageId === reference.id).length,
    10,
  );
});

test("regular episode title numbers form a nondecreasing publication timeline", () => {
  const episodes = newsDataset.pages
    .filter((page) => page.episode?.series === "bedtimenews")
    .sort((left, right) => left.episode.number - right.episode.number);

  assert.ok(episodes.length > 800);
  for (let index = 1; index < episodes.length; index += 1) {
    assert.ok(
      episodes[index - 1].publishedAt <= episodes[index].publishedAt,
      `episode ${episodes[index].episode.number} predates episode ${episodes[index - 1].episode.number}`,
    );
  }
  assert.ok(
    episodes.some(
      (page) =>
        page.dateProvenance.observedAt !== page.publishedAt &&
        page.dateProvenance.resolution === "corrected_sequence_outlier",
    ),
  );
});

test("multi-news pages do not lend their page title to a news item", () => {
  const pagesById = new Map(
    newsDataset.pages.map((page) => [page.id, page]),
  );
  const pageNamedNews = newsDataset.news.filter((item) => {
    const page = pagesById.get(item.pageId);
    return page?.segmentation.newsCount > 1 && item.title === page.title;
  });

  assert.deepEqual(pageNamedNews, []);
  assert.equal(
    newsDataset.news.some((item) => /^(?:Tabs|B站|西瓜视频|YouTube)$/iu.test(item.title)),
    false,
  );
});

test("ontology exposes the homepage search facets", () => {
  assert.equal(ontology.recordUnit.id, "news");
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
  const thresholds = [
    ["entity coverage", coverageReport.coverage.entityCoveragePercent, 100],
    ["event type coverage", coverageReport.coverage.eventTypeCoveragePercent, 80],
    ["place facet coverage", coverageReport.coverage.facetCoverage.place.percent, 80],
    ["topic facet coverage", coverageReport.coverage.facetCoverage.topic.percent, 90],
    ["subject facet coverage", coverageReport.coverage.facetCoverage.subject.percent, 30],
  ];
  for (const [label, actual, minimum] of thresholds) {
    assert.ok(
      actual >= minimum,
      `${label} is ${actual}%, below the reviewed ${minimum}% minimum`,
    );
  }
});

test("every event is traceable to a repository source", () => {
  const sources = new Map(kg.sources.map((source) => [source.id, source]));
  for (const event of kg.events) {
    assert.match(event.newsId, /^news-/u);
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
