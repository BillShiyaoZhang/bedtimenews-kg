#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const [ontology, seedFile] = await Promise.all([
  readJson(resolve(projectRoot, "data/ontology.json")),
  readJson(resolve(projectRoot, "data/seeds/entities.json")),
]);
const seedEntities = seedFile.entities;
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
const events = [];

for (const filePath of markdownFiles) {
  const repositoryPath = relative(sourceRoot, filePath).replaceAll("\\", "/");
  const raw = await readFile(filePath, "utf8");
  const { attributes, body } = parseFrontMatter(raw);
  if (attributes.published === "false") continue;
  const sourceId = `source-${shortHash(repositoryPath)}`;
  const sourceDate = extractDate(repositoryPath, body, attributes);
  const sourceTitle =
    attributes.title || firstHeading(body) || basename(filePath, ".md");
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

  const sections = repositoryPath.startsWith("daily/")
    ? splitDailySections(body)
    : [
        {
          title: sourceTitle,
          text: attributes.description || meaningfulParagraph(body),
          raw: body,
        },
      ];

  sections.forEach((section, index) => {
    const eventDate =
      extractExplicitDate(section.raw)?.date ?? sourceDate ?? "1900-01-01";
    const entityIds = matchEntities(section.raw, seedEntities);
    const eventId = `event-${shortHash(`${repositoryPath}:${index}:${section.title}`)}`;
    events.push({
      id: eventId,
      title: cleanText(section.title).slice(0, 160),
      date: eventDate,
      datePrecision: extractExplicitDate(section.raw)?.precision ?? datePrecision(eventDate),
      type: classifyEvent(`${section.title}\n${section.text}`),
      summary: cleanText(section.text).slice(0, 360),
      entityIds,
      sourceIds: [sourceId],
      significance: "",
    });
  });
}

const eventRelations = buildChronologyRelations(events, seedEntities);
const kg = {
  schemaVersion: ontology.version,
  generatedAt,
  source: {
    name: "bedtimenews/bedtimenews-archive-contents",
    url: "https://github.com/bedtimenews/bedtimenews-archive-contents",
    licenseNote:
      "本文件保存结构化索引、摘要与出处链接；原文版权归原作者与原仓库。",
    mode: "deterministic-extraction",
  },
  entities: seedEntities.map((entity) => ({
    description: "",
    aliases: [],
    ...entity,
  })),
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
  throw new Error(`Generated KG failed validation with ${issues.length} issue(s).`);
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(kg, null, 2)}\n`, "utf8");
console.log(
  `Generated ${relative(projectRoot, outputPath)} from ${markdownFiles.length} files: ` +
    `${events.length} events, ${kg.entities.length} entities, ${eventRelations.length} relations.`,
);

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
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { attributes: {}, body: raw };
  const attributes = {};
  match[1].split(/\r?\n/).forEach((line) => {
    const separator = line.indexOf(":");
    if (separator === -1) return;
    attributes[line.slice(0, separator).trim()] = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  });
  return { attributes, body: raw.slice(match[0].length) };
}

function splitDailySections(body) {
  const matches = Array.from(
    body.matchAll(/^##\s+(?:\[?\s*\d+[.、]?\s*\]?[.、]?\s*)?(.+)$/gm),
  );
  if (!matches.length) {
    return [
      {
        title: firstHeading(body) || "每日新闻",
        text: meaningfulParagraph(body),
        raw: body,
      },
    ];
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? body.length;
    const raw = body.slice(start, end);
    return {
      title: match[1],
      text: meaningfulParagraph(raw),
      raw,
    };
  });
}

function firstHeading(body) {
  return body.match(/^#{1,3}\s+(.+)$/m)?.[1];
}

function meaningfulParagraph(body) {
  return (
    body
      .split(/\n\s*\n/)
      .map(cleanText)
      .find((paragraph) => paragraph.length >= 30) ?? cleanText(body)
  );
}

function cleanText(value = "") {
  return value
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDate(repositoryPath, body, attributes) {
  const pathDate = repositoryPath.match(
    /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})\.md$/,
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
    /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
  );
  if (chinese) {
    return {
      date: `${chinese[1]}-${pad(chinese[2])}-${pad(chinese[3])}`,
      precision: "day",
    };
  }
  const iso = value.match(/((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return {
      date: `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`,
      precision: "day",
    };
  }
  return null;
}

function normalizeIsoDate(value) {
  return value?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
}

function datePrecision(date) {
  return date.endsWith("-01-01") ? "year" : "day";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function matchEntities(text, entities) {
  return entities
    .filter((entity) =>
      [entity.label, ...(entity.aliases ?? [])].some(
        (alias) => alias && text.includes(alias),
      ),
    )
    .map((entity) => entity.id);
}

function classifyEvent(text) {
  const rules = [
    ["infrastructure", /铁路|高铁|大桥|公路|开工|通车|基建/],
    ["policy_change", /政策|规划|条例|通知|监管|发布|方案/],
    ["market_shift", /价格|市场|进口|出口|供需|违约|涨|跌/],
    ["technology", /技术|产量|研发|设备|突破|页岩气/],
    ["public_debate", /争议|质疑|舆论|回应|调查/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? "historical_milestone";
}

function buildChronologyRelations(events, entities) {
  const relations = [];
  const seen = new Set();
  for (const entity of entities) {
    const timeline = events
      .filter((event) => event.entityIds.includes(entity.id))
      .sort((a, b) => a.date.localeCompare(b.date));
    for (let index = 1; index < timeline.length; index += 1) {
      const previous = timeline[index - 1];
      const current = timeline[index];
      const key = `${previous.id}:${current.id}`;
      if (previous.date === current.date || seen.has(key)) continue;
      seen.add(key);
      relations.push({
        id: `rel-${shortHash(`${key}:precedes`)}`,
        from: previous.id,
        to: current.id,
        type: "precedes",
        confidence: 1,
        evidence: `两事件均涉及“${entity.label}”，并具有可确认的时间先后顺序。此关系仅表达时间顺序，不表达因果。`,
        sourceId: current.sourceIds[0],
      });
    }
  }
  return relations;
}

function archiveUrl(repositoryPath) {
  return `https://archive.bedtime.news/zh/${repositoryPath.replace(/\.md$/, "")}`;
}

function shortHash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
