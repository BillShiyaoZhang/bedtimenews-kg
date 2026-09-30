import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createExtractionEngine, materializeEntity, shouldKeepCandidate } from "./extraction.mjs";
import { cleanText, readNewsFragment } from "./news.mjs";

// One materialization algorithm for accepted legacy builds and offline candidates.
export function buildKnowledgeGraph({ dataset, rawPages, ontology, rules, generatedAt, collectTrace = false }) {
  if (typeof generatedAt !== "string" || !generatedAt) throw new Error("An explicit deterministic generatedAt is required");
  const extractor = createExtractionEngine(rules);
  const trace = { news: [], retention: [], rescans: [], chronology: [] };
  const newsDataset = canonicalDataset(dataset);
  const pageById = new Map(newsDataset.pages.map((page) => [page.id, page]));
  const draftEvents = [];
  const candidateStats = new Map();

  for (const item of newsDataset.news) {
    const page = pageById.get(item.pageId);
    if (!page) throw new Error(`${item.id} references missing page ${item.pageId}.`);
    const raw = rawPages.get(page.id);
    if (typeof raw !== "string" || createHash("sha256").update(raw).digest("hex") !== page.contentHash) throw new Error(`${page.id} source hash mismatch`);
    const fragment = readNewsFragment(raw, item.fragment);
    const eventId = `event-${shortHash(item.id)}`;
    const text = `${item.title}\n${item.summary}\n${fragment}`;
    const prominent = `${item.title}\n${item.summary}`;
    const searchText = cleanText(text);
    const extraction = collectTrace ? extractor.extractCandidateDecisions(text, prominent, { newsId: item.id }) : { candidates: extractor.extractCandidates(text, prominent, { newsId: item.id }) };
    const candidates = extraction.candidates;
    const classification = collectTrace ? extractor.classifyEventDecision(prominent, text) : { type: extractor.classifyEvent(prominent, text) };
    if (collectTrace) trace.news.push({ newsId: item.id, eventId, observations: extraction.observations, classification, inputs: { text, prominent, fragment, search: searchText } });
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
      type: classification.type,
      summary: item.summary,
      candidateKeys,
      // Only this news fragment may supply evidence, never the containing page.
      topicEvidence: extractor.matchTopicEvidence(fragment),
      searchText,
      sourceIds: [item.pageId],
      significance: "",
    });
  }

  const allStats = [...candidateStats.values()]
    .map((stat) => ({
      ...stat,
      aliases: [...stat.aliases],
      eventCount: stat.eventIds.size,
    }));
  const retainedStats = allStats.filter(shouldKeepCandidate);
  if (collectTrace) for (const stat of allStats) trace.retention.push({ candidateKey: stat.key, entityId: materializeEntity(stat).id, type: stat.type, label: stat.label, method: stat.method, confidence: stat.confidence, prominent: stat.prominent, directEventIds: [...stat.eventIds].sort(), retained: shouldKeepCandidate(stat), criterion: retentionCriterion(stat) });
  const provisionalEntities = retainedStats
    .map(materializeEntity)
    .sort(
      (left, right) =>
        left.type.localeCompare(right.type) ||
        left.label.localeCompare(right.label, "zh-CN"),
    );
  const retainedEntityIds = new Map(
    retainedStats.map((stat) => [stat.key, materializeEntity(stat).id]),
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
  const events = draftEvents.map(({ candidateKeys, searchText, ...event }) => {
    const rescanned = matchableEntities.filter((entity) => entity.values.some((value) => searchText.includes(value)));
    if (collectTrace) for (const entity of rescanned) {
      const matches = entity.values.flatMap((text) => exactMatches(searchText, text));
      trace.rescans.push({ eventId: event.id, entityId: entity.id, matches, normalizationId: "clean-text-v1" });
    }
    return { ...event, entityIds: [...new Set([...candidateKeys.map((key) => retainedEntityIds.get(key)).filter(Boolean), ...rescanned.map((entity) => entity.id)])] };
  });
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
  const eventRelations = buildChronologyRelations(events, entities, collectTrace ? trace.chronology : null);
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
      ontologyCompilation: ontology.compilation,
    },
    entities,
    events,
    eventRelations,
    entityRelations: [],
    sources: newsDataset.pages,
  };

  return { kg, trace };
}

function buildChronologyRelations(events, entities, derivations) {
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
      if (previous.date === current.date) continue;
      if (derivations) derivations.push({ relationId: `relation-${shortHash(`${pair}:precedes`)}`, from: previous.id, to: current.id, viaEntityId: entity.id, maximumMentions, mentionedEventIds: [...mentionedIds].sort() });
      if (seenPairs.has(pair)) continue;
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

export async function readVerifiedPages(dataset, sourceRoot) {
  const pages = new Map();
  for (const page of dataset.pages) {
    const raw = await readFile(resolve(sourceRoot, page.repositoryPath), "utf8");
    if (createHash("sha256").update(raw).digest("hex") !== page.contentHash) throw new Error(`${page.id} source hash mismatch`);
    pages.set(page.id, raw);
  }
  return pages;
}

export function canonicalDataset(dataset) {
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const paths = new Map(dataset.pages.map((page) => [page.id, page.repositoryPath]));
  return { ...dataset,
    pages: [...dataset.pages].sort((a, b) => compare(a.repositoryPath, b.repositoryPath)),
    news: [...dataset.news].sort((a, b) => compare(paths.get(a.pageId), paths.get(b.pageId)) || a.fragment.ordinal - b.fragment.ordinal || compare(a.id, b.id)),
  };
}

function exactMatches(input, text) {
  const values = [];
  if (!text) return values;
  for (let start = input.indexOf(text); start !== -1; start = input.indexOf(text, start + text.length)) values.push({ text, start, end: start + text.length });
  return values;
}

function retentionCriterion(stat) {
  if (["controlled_vocabulary", "gazetteer", "reviewed_news_link", "document_title", "named_document"].includes(stat.method)) return { kind: "trusted_extraction_method", method: stat.method };
  if (["person", "organization", "facility"].includes(stat.type)) return { kind: "distinct_direct_news", minimum: 2 };
  return { kind: "prominent_or_distinct_direct_news", minimum: 2 };
}

function shortHash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}
