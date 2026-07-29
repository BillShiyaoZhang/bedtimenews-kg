#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExtractionEngine,
  materializeEntity,
  shouldKeepCandidate,
} from "./lib/extraction.mjs";
import {
  cleanText,
  normalizeIdentifier,
  readNewsFragment,
  validateKnowledgeBaseNewsProjection,
  validateNewsDataset,
} from "./lib/news.mjs";
import { validate } from "./lib/validate.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(
  args.source ??
    process.env.BEDTIMENEWS_ARCHIVE ??
    "sources/bedtimenews-archive-contents",
);
const newsPath = resolve(
  projectRoot,
  args.news ?? "data/processed/news.json",
);
const outputPath = resolve(
  projectRoot,
  args.output ?? "data/generated/kg.json",
);
const generatedAt = String(args["generated-at"] ?? new Date().toISOString());

const [ontology, extractionRules, newsDataset] = await Promise.all([
  readJson(resolve(projectRoot, "data/ontology.json")),
  readJson(resolve(projectRoot, "data/extraction-rules.json")),
  readJson(newsPath),
]);
const datasetIssues = validateNewsDataset(newsDataset);
if (datasetIssues.length) {
  throw new Error(
    `Processed news dataset is invalid:\n${datasetIssues
      .slice(0, 20)
      .map((item) => `[${item.level}] ${item.path}: ${item.message}`)
      .join("\n")}`,
  );
}

const extractor = createExtractionEngine(extractionRules);
const pageById = new Map(newsDataset.pages.map((page) => [page.id, page]));
const rawPageCache = new Map();
const draftEvents = [];
const candidateStats = new Map();

for (const item of newsDataset.news) {
  const page = pageById.get(item.pageId);
  if (!page) throw new Error(`${item.id} references missing page ${item.pageId}.`);
  let raw = rawPageCache.get(page.id);
  if (raw === undefined) {
    raw = await readFile(resolve(sourceRoot, page.repositoryPath), "utf8");
    rawPageCache.set(page.id, raw);
  }
  const fragment = readNewsFragment(raw, item.fragment);
  const eventId = `event-${shortHash(item.id)}`;
  const candidates = extractor.extractCandidates(
    `${item.title}\n${item.summary}\n${fragment}`,
    `${item.title}\n${item.summary}`,
  );
  const candidateKeys = [];
  for (const candidate of candidates) {
    candidateKeys.push(candidate.key);
    const existing = candidateStats.get(candidate.key) ?? {
      ...candidate,
      aliases: new Set(candidate.aliases ?? []),
      eventIds: new Set(),
      prominent: false,
    };
    for (const alias of candidate.aliases ?? []) existing.aliases.add(alias);
    existing.eventIds.add(eventId);
    existing.prominent ||= candidate.prominent;
    if (candidate.confidence > existing.confidence) {
      existing.method = candidate.method;
    }
    existing.confidence = Math.max(
      existing.confidence,
      candidate.confidence,
    );
    candidateStats.set(candidate.key, existing);
  }
  draftEvents.push({
    id: eventId,
    newsId: item.id,
    title: item.title,
    date: item.date,
    datePrecision: item.datePrecision,
    type: extractor.classifyEvent(
      `${item.title}\n${item.summary}`,
      `${item.title}\n${item.summary}\n${fragment}`,
    ),
    summary: item.summary,
    candidateKeys,
    searchText: cleanText(`${item.title}\n${item.summary}\n${fragment}`),
    sourceIds: [item.pageId],
    significance: "",
  });
}

const retainedStats = [...candidateStats.values()]
  .map((stat) => ({
    ...stat,
    aliases: [...stat.aliases],
    eventCount: stat.eventIds.size,
  }))
  .filter(shouldKeepCandidate);
const provisionalEntities = retainedStats
  .map(materializeEntity)
  .sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      left.label.localeCompare(right.label, "zh-CN"),
  );
const retainedEntityIds = new Map(
  provisionalEntities.map((entity) => [
    `${entity.type}:${normalizeIdentifier(entity.label)}`,
    entity.id,
  ]),
);
const matchableEntities = provisionalEntities
  .filter((entity) =>
    ["person", "organization", "facility"].includes(entity.type),
  )
  .map((entity) => ({
    id: entity.id,
    values: [entity.label, ...entity.aliases].filter(
      (value) => entity.type !== "person" || value.length >= 3,
    ),
  }));
const events = draftEvents.map(
  ({ candidateKeys, searchText, ...event }) => ({
    ...event,
    entityIds: [
      ...new Set([
        ...candidateKeys
          .map((key) => retainedEntityIds.get(key))
          .filter(Boolean),
        ...matchableEntities
          .filter((entity) =>
            entity.values.some((value) => searchText.includes(value)),
          )
          .map((entity) => entity.id),
      ]),
    ],
  }),
);
const finalEntityEventCounts = new Map(
  provisionalEntities.map((entity) => [entity.id, 0]),
);
for (const event of events) {
  for (const id of event.entityIds) {
    finalEntityEventCounts.set(id, (finalEntityEventCounts.get(id) ?? 0) + 1);
  }
}
const entities = retainedStats
  .map((stat) => {
    const provisional = materializeEntity(stat);
    return materializeEntity({
      ...stat,
      eventCount: finalEntityEventCounts.get(provisional.id) ?? 0,
    });
  })
  .sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      left.label.localeCompare(right.label, "zh-CN"),
  );
const eventRelations = buildChronologyRelations(events, entities);
const kg = {
  schemaVersion: ontology.version,
  generatedAt,
  source: {
    name: "bedtimenews/bedtimenews-archive-contents",
    url: "https://github.com/bedtimenews/bedtimenews-archive-contents",
    licenseNote:
      "本文件保存结构化索引、摘要与出处链接；原文版权归原作者与原仓库。",
    mode: "deterministic-semantic-extraction-from-processed-news",
    newsDatasetSchemaVersion: newsDataset.schemaVersion,
    segmentationVersion: newsDataset.segmentation.version,
    newsOverrideVersion: newsDataset.segmentation.overrideVersion,
    extractionVersion: extractor.version,
  },
  entities,
  events,
  eventRelations,
  entityRelations: [],
  sources: newsDataset.pages,
};

const issues = [
  ...validate(kg, ontology),
  ...validateKnowledgeBaseNewsProjection(kg, newsDataset),
];
if (issues.length) {
  for (const issue of issues.slice(0, 30)) {
    console.error(`[${issue.level}] ${issue.path}: ${issue.message}`);
  }
  throw new Error(
    `Generated KG failed validation with ${issues.length} issue(s).`,
  );
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(kg, null, 2)}\n`, "utf8");
const coveredEvents = events.filter((event) => event.entityIds.length).length;
console.log(
  `Generated ${relative(projectRoot, outputPath)} from ${events.length} independent news ` +
    `items on ${newsDataset.pages.length} referenced pages: ${entities.length} entities, ` +
    `${eventRelations.length} relations; ${percentage(coveredEvents, events.length)}% ` +
    "of news items have semantic entities.",
);

function buildChronologyRelations(events, entities) {
  const relations = [];
  const seenPairs = new Set();
  const eventIdsByEntity = new Map();
  for (const event of events) {
    for (const id of event.entityIds) {
      const ids = eventIdsByEntity.get(id) ?? [];
      ids.push(event.id);
      eventIdsByEntity.set(id, ids);
    }
  }
  const eventsById = new Map(events.map((event) => [event.id, event]));
  for (const entity of entities) {
    if (entity.type === "topic") continue;
    const mentionedIds = eventIdsByEntity.get(entity.id) ?? [];
    const maximumMentions = entity.type === "place" ? 90 : 250;
    if (mentionedIds.length < 2 || mentionedIds.length > maximumMentions) {
      continue;
    }
    const timeline = mentionedIds
      .map((id) => eventsById.get(id))
      .filter((event) => event && event.date !== "1900-01-01")
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
      );
    for (let index = 1; index < timeline.length; index += 1) {
      const previous = timeline[index - 1];
      const current = timeline[index];
      const pair = `${previous.id}:${current.id}`;
      if (previous.date === current.date || seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      relations.push({
        id: `relation-${shortHash(`${pair}:precedes`)}`,
        from: previous.id,
        to: current.id,
        type: "precedes",
        viaEntityId: entity.id,
        confidence: 1,
        evidence: `两条新闻均明确涉及“${entity.label}”，且日期可确认先后；此关系只表达时间顺序，不表达因果。`,
        sourceId: current.sourceIds[0],
      });
    }
  }
  return relations;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) parsed[key] = inlineValue;
    else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[key] = values[++index];
    } else parsed[key] = true;
  }
  return parsed;
}

function percentage(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}

function shortHash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
