import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createEntitySearchDocument,
  createEventSearchDocument,
  matchesSearchDocument,
  normalizeSearchText,
  parseSearchQuery,
  rankEventSearchDocument,
} from "../app/lib/search.mjs";

const root = new URL("../", import.meta.url);
const [kg, ontology] = await Promise.all([
  readJson(new URL("data/generated/kg.json", root)),
  readJson(new URL("data/ontology.json", root)),
]);
const entityById = new Map(kg.entities.map((entity) => [entity.id, entity]));
const sourceById = new Map(kg.sources.map((source) => [source.id, source]));
const eventTypeById = new Map(
  ontology.eventTypes.map((type) => [type.id, type]),
);
const entityTypeById = new Map(
  ontology.entityTypes.map((type) => [type.id, type]),
);

const documents = kg.events.map((event) => {
  const entities = event.entityIds
    .map((id) => entityById.get(id))
    .filter(Boolean);
  return createEventSearchDocument({
    event,
    entities,
    source: sourceById.get(event.sourceIds[0]),
    eventType: eventTypeById.get(event.type),
    entityTypes: entities
      .map((entity) => entityTypeById.get(entity.type))
      .filter(Boolean),
  });
});

test("search normalization folds width, case, accents, spaces, and punctuation", () => {
  assert.equal(normalizeSearchText(" ＧＰＴ‑4 / Café "), "gpt4cafe");
});

test("search expands reviewed abbreviations and administrative suffixes", () => {
  const document = createEventSearchDocument({
    event: {
      title: "北京用人工智能分析新冠数据",
      summary: "世界卫生组织参与讨论",
      significance: "",
      type: "science_technology",
      date: "2024-01-01",
    },
  });
  for (const query of ["北京市", "AI", "COVID-19", "WHO"]) {
    assert.equal(
      matchesSearchDocument(document, parseSearchQuery(query)),
      true,
      `expected ${query} to match`,
    );
  }
});

test("event type labels, entity aliases, and source metadata are searchable", () => {
  const entity = {
    label: "北京市",
    aliases: ["北京"],
    description: "标准地名",
    type: "place",
  };
  const document = createEventSearchDocument({
    event: {
      title: "发布会举行",
      summary: "",
      significance: "",
      type: "public_health",
      date: "2024-01-01",
    },
    entities: [entity],
    source: { title: "睡前消息", kind: "日报", repositoryPath: "daily/1.md" },
    eventType: { label: "公共卫生", description: "群体健康风险变化" },
    entityTypes: [{ label: "地点", description: "地理区域" }],
  });
  for (const query of ["公共卫生", "北京", "日报", "地点"]) {
    assert.equal(
      matchesSearchDocument(document, parseSearchQuery(query)),
      true,
      `expected ${query} to match`,
    );
  }
});

test("search requires every term while accepting a synonym for each term", () => {
  const document = createEventSearchDocument({
    event: {
      title: "人工智能支持疫情研究",
      summary: "",
      significance: "",
      type: "science_technology",
      date: "2024-01-01",
    },
  });
  assert.equal(
    matchesSearchDocument(document, parseSearchQuery("AI COVID-19")),
    true,
  );
  assert.equal(
    matchesSearchDocument(document, parseSearchQuery("AI 铁路")),
    false,
  );
});

test("exact title matches rank above metadata-only matches", () => {
  const exact = createEventSearchDocument({
    event: {
      title: "人工智能",
      summary: "",
      significance: "",
      type: "science_technology",
      date: "2024-01-01",
    },
  });
  const metadata = createEventSearchDocument({
    event: {
      title: "行业观察",
      summary: "",
      significance: "",
      type: "science_technology",
      date: "2024-01-01",
    },
    entities: [{ label: "人工智能", aliases: [], description: "", type: "topic" }],
  });
  assert.ok(
    rankEventSearchDocument(exact, "人工智能") >
      rankEventSearchDocument(metadata, "人工智能"),
  );
});

test("real KG search benchmark has complete recall for representative queries", () => {
  const benchmarks = [
    ["GPT4", /GPT-?4/iu],
    ["C919", /C919/iu],
    ["AI", /人工智能|AI|大模型/iu],
    ["COVID-19", /新冠|疫情|防疫/iu],
    ["北京市", /北京/u],
  ];
  for (const [query, expectedTitle] of benchmarks) {
    const matches = documents.filter((document) =>
      matchesSearchDocument(document, parseSearchQuery(query)),
    );
    assert.ok(matches.length > 0, `${query} returned no results`);
    assert.ok(
      matches.some(({ event }) => expectedTitle.test(event.title)),
      `${query} missed its benchmark result`,
    );
  }
});

test("every published entity has a non-empty searchable document", () => {
  for (const entity of kg.entities) {
    const document = createEntitySearchDocument(
      entity,
      entityTypeById.get(entity.type),
    );
    assert.ok(document.text, `${entity.id} is not searchable`);
  }
});

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}
