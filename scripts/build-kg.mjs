#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExtractionEngine,
  materializeEntity,
  shouldKeepCandidate,
} from "./lib/extraction.mjs";
import { validate } from "./lib/validate.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(
  args.source ??
    process.env.BEDTIMENEWS_ARCHIVE ??
    "sources/bedtimenews-archive-contents",
);
const outputPath = resolve(
  projectRoot,
  args.output ?? "data/generated/kg.json",
);
const limit = Number(args.limit ?? 0);
const includeRoots = String(
  args.include ??
    "main,daily,reference,opinion,business,commercial,livestream,shorts",
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const generatedAt = String(args["generated-at"] ?? new Date().toISOString());

const [ontology, extractionRules] = await Promise.all([
  readJson(resolve(projectRoot, "data/ontology.json")),
  readJson(resolve(projectRoot, "data/extraction-rules.json")),
]);
const extractor = createExtractionEngine(extractionRules);
const markdownFiles = (
  await Promise.all(
    includeRoots.map((folder) => walk(resolve(sourceRoot, folder))),
  )
)
  .flat()
  .filter((path) => extname(path) === ".md")
  .sort()
  .slice(0, limit || undefined);

if (!markdownFiles.length) {
  throw new Error(
    `No Markdown files found under ${sourceRoot}. ` +
      "Pass --source /path/to/bedtimenews-archive-contents.",
  );
}

const sources = [];
const draftEvents = [];
const candidateStats = new Map();

for (const filePath of markdownFiles) {
  const repositoryPath = relative(sourceRoot, filePath).replaceAll("\\", "/");
  const raw = await readFile(filePath, "utf8");
  const { attributes, body } = parseFrontMatter(raw);
  if (attributes.published === "false" || isNavigationIndex(body)) continue;

  const sourceId = `source-${shortHash(repositoryPath)}`;
  const sourceDate = extractDate(repositoryPath, body, attributes);
  const sourceTitle =
    attributes.title || firstHeading(body) || basename(filePath, ".md");
  const sections = splitEventSections(
    repositoryPath,
    body,
    sourceTitle,
    attributes.description,
  );
  if (!sections.length) continue;

  sources.push({
    id: sourceId,
    title: sourceTitle,
    archiveUrl: archiveUrl(repositoryPath),
    repositoryPath,
    repositoryUrl:
      "https://github.com/bedtimenews/bedtimenews-archive-contents/blob/main/" +
      repositoryPath,
    publishedAt: sourceDate,
    kind: sourceKind(repositoryPath),
  });

  sections.forEach((section, index) => {
    const explicitDate = extractExplicitDate(section.raw);
    const eventDate = explicitDate?.date ?? sourceDate ?? "1900-01-01";
    const title = cleanText(section.title).slice(0, 160) || sourceTitle;
    const summary = cleanText(section.text).slice(0, 420);
    const eventIdValue = `event-${shortHash(
      `${repositoryPath}:${index}:${title}`,
    )}`;
    const candidates = extractor.extractCandidates(
      `${title}\n${summary}\n${section.raw}`,
      `${title}\n${summary}`,
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
      existing.eventIds.add(eventIdValue);
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
      id: eventIdValue,
      title,
      date: eventDate,
      datePrecision: explicitDate?.precision ?? datePrecision(eventDate),
      type: extractor.classifyEvent(`${title}\n${summary}`),
      summary,
      candidateKeys,
      searchText: cleanText(`${title}\n${summary}\n${section.raw}`),
      sourceIds: [sourceId],
      significance: "",
    });
  });
}

const entities = [...candidateStats.values()]
  .map((stat) => ({
    ...stat,
    aliases: [...stat.aliases],
    eventCount: stat.eventIds.size,
  }))
  .filter(shouldKeepCandidate)
  .map(materializeEntity)
  .sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      left.label.localeCompare(right.label, "zh-CN"),
  );
const retainedEntityIds = new Map(
  entities.map((entity) => [
    `${entity.type}:${normalizeIdentifier(entity.label)}`,
    entity.id,
  ]),
);
const matchableEntities = entities
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
const eventRelations = buildChronologyRelations(events, entities);
const kg = {
  schemaVersion: ontology.version,
  generatedAt,
  source: {
    name: "bedtimenews/bedtimenews-archive-contents",
    url: "https://github.com/bedtimenews/bedtimenews-archive-contents",
    licenseNote:
      "本文件保存结构化索引、摘要与出处链接；原文版权归原作者与原仓库。",
    mode: "deterministic-semantic-extraction",
    extractionVersion: extractor.version,
  },
  entities,
  events,
  eventRelations,
  entityRelations: [],
  sources,
};

const issues = validate(kg, ontology);
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
  `Generated ${relative(projectRoot, outputPath)} from ${sources.length} content files: ` +
    `${events.length} events, ${entities.length} entities, ${eventRelations.length} relations; ` +
    `${percentage(coveredEvents, events.length)}% of events have semantic entities.`,
);

function splitEventSections(
  repositoryPath,
  body,
  sourceTitle,
  description,
) {
  if (repositoryPath.startsWith("daily/")) return splitDailySections(body);

  const segments = body
    .split(/^\s*---\s*$/gmu)
    .map((segment) => segment.trim())
    .filter((segment) => cleanText(segment).length >= 100);
  if (segments.length <= 1) {
    return [
      {
        title: sourceTitle,
        text: description || meaningfulParagraph(body),
        raw: body,
      },
    ];
  }
  return segments.map((segment, index) => ({
    title:
      index === 0
        ? sourceTitle
        : sectionTitle(segment) || `${sourceTitle} · ${index + 1}`,
    text: meaningfulParagraph(segment),
    raw: segment,
  }));
}

function splitDailySections(body) {
  const matches = Array.from(
    body.matchAll(/^##\s+(?:\[?\s*\d+[.、]?\s*\]?[.、]?\s*)?(.+)$/gmu),
  ).filter((match) => !/^(?:B站|西瓜视频|YouTube)$/iu.test(match[1].trim()));
  if (!matches.length) {
    return [
      {
        title: firstHeading(body) || "每日新闻",
        text: meaningfulParagraph(body),
        raw: body,
      },
    ];
  }
  return matches
    .map((match, index) => {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? body.length;
      const raw = body.slice(start, end);
      return {
        title: match[1],
        text: meaningfulParagraph(raw),
        raw,
      };
    })
    .filter((section) => cleanText(section.raw).length >= 40);
}

function sectionTitle(segment) {
  const fontPrompt = segment.match(
    /<font[^>]*>([\s\S]{8,220}?)<\/font>/iu,
  )?.[1];
  const heading = Array.from(segment.matchAll(/^#{1,3}\s+(.+)$/gmu))
    .map((match) => cleanText(match[1]))
    .find((value) => value && !/^(?:Tabs|B站|西瓜视频|YouTube)$/iu.test(value));
  const candidate = cleanText(fontPrompt || heading || meaningfulParagraph(segment));
  return firstSentence(candidate).slice(0, 90);
}

function isNavigationIndex(body) {
  const linkItems = body.match(/^\s*-\s+\[[^\]]+\]\([^)]+\.md\)/gmu)?.length ?? 0;
  if (linkItems < 5) return false;
  const proseLines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length >= 80 &&
        !/^[-#<{[]/u.test(line) &&
        !/^\[[^\]]+\]\([^)]+\)$/u.test(line),
    );
  return proseLines.length === 0;
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

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      }),
  );
  return nested.flat();
}

function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!match) return { attributes: {}, body: raw };
  const attributes = {};
  match[1].split(/\r?\n/u).forEach((line) => {
    const separator = line.indexOf(":");
    if (separator === -1) return;
    attributes[line.slice(0, separator).trim()] = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "");
  });
  return { attributes, body: raw.slice(match[0].length) };
}

function firstHeading(body) {
  return body.match(/^#{1,3}\s+(.+)$/mu)?.[1];
}

function meaningfulParagraph(body) {
  return (
    body
      .split(/\n\s*\n/u)
      .map(cleanText)
      .find(
        (paragraph) =>
          paragraph.length >= 30 &&
          !/^(?:Tabs|B站|西瓜视频|YouTube|以下文本为)/iu.test(paragraph),
      ) ?? cleanText(body)
  );
}

function firstSentence(value) {
  return value.split(/[。！？!?；;]/u)[0]?.trim() ?? value;
}

function cleanText(value = "") {
  return String(value)
    .replace(/!\[[^\]]*\]\([^)]+\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[#>*_`~|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractDate(repositoryPath, body, attributes) {
  const pathDate = repositoryPath.match(
    /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})\.md$/u,
  );
  if (pathDate) return `${pathDate[1]}-${pathDate[2]}-${pathDate[3]}`;
  return (
    normalizeIsoDate(attributes.dateCreated || attributes.date) ??
    extractExplicitDate(body)?.date ??
    "1900-01-01"
  );
}

function sourceKind(repositoryPath) {
  const root = repositoryPath.split("/", 1)[0];
  return root === "main" ? "episode" : root;
}

function extractExplicitDate(value) {
  const chinese = value.match(
    /((?:18|19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u,
  );
  if (chinese) {
    return {
      date: `${chinese[1]}-${pad(chinese[2])}-${pad(chinese[3])}`,
      precision: "day",
    };
  }
  const iso = value.match(/((?:18|19|20)\d{2})-(\d{1,2})-(\d{1,2})/u);
  if (iso) {
    return {
      date: `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`,
      precision: "day",
    };
  }
  const year = value.match(/((?:18|19|20)\d{2})\s*年/u);
  if (year) {
    return { date: `${year[1]}-01-01`, precision: "year" };
  }
  return null;
}

function normalizeIsoDate(value) {
  return value?.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1];
}

function datePrecision(date) {
  return date.endsWith("-01-01") ? "year" : "day";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

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
        evidence: `两事件均明确涉及“${entity.label}”，且日期可确认先后；此关系只表达时间顺序，不表达因果。`,
        sourceId: current.sourceIds[0],
      });
    }
  }
  return relations;
}

function archiveUrl(repositoryPath) {
  return `https://archive.bedtime.news/zh/${repositoryPath.replace(/\.md$/u, "")}`;
}

function normalizeIdentifier(value) {
  return String(value)
    .replace(/\s+/gu, "")
    .replace(/[《》“”"'（）()_-]/gu, "")
    .toLocaleLowerCase("zh-CN");
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
