const SYNONYM_GROUPS = [
  ["ai", "人工智能", "机器智能"],
  ["大模型", "大型语言模型", "llm"],
  ["新冠", "新型冠状病毒", "疫情", "防疫", "covid", "covid19"],
  ["世界卫生组织", "世卫组织", "who"],
  ["北约", "nato"],
  ["欧盟", "欧洲联盟", "eu"],
  ["联合国", "un"],
  ["一带一路", "丝绸之路经济带"],
];

const ADMINISTRATIVE_SUFFIXES = [
  "特别行政区",
  "维吾尔自治区",
  "壮族自治区",
  "回族自治区",
  "自治区",
  "自治州",
  "自治县",
  "省",
  "市",
  "区",
  "县",
];

const normalizedSynonymGroups = SYNONYM_GROUPS.map((group) =>
  group.map(normalizeSearchText),
);

export function normalizeSearchText(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function parseSearchQuery(value) {
  const rawTerms =
    String(value).match(/"[^"]+"|“[^”]+”|'[^']+'|\S+/gu)?.map((term) =>
      term.replace(/^["“']|["”']$/gu, ""),
    ) ?? [];
  return rawTerms
    .map((term) => expandSearchTerm(term))
    .filter((alternatives) => alternatives.length);
}

export function createEventSearchDocument({
  event,
  entities = /** @type {Array<any>} */ ([]),
  source,
  eventType,
  entityTypes = /** @type {Array<any>} */ ([]),
}) {
  const fields = {
    title: normalizeSearchText(event.title),
    summary: normalizeSearchText(event.summary),
    significance: normalizeSearchText(event.significance),
    entities: normalizeSearchText(
      entities
        .flatMap((entity) => [
          entity.label,
          ...(entity.aliases ?? []),
          entity.description,
        ])
        .join(" "),
    ),
    source: normalizeSearchText(
      [source?.title, source?.kind, source?.repositoryPath].join(" "),
    ),
    types: normalizeSearchText(
      [
        event.type,
        eventType?.label,
        eventType?.description,
        ...entityTypes.flatMap((type) => [type.label, type.description]),
      ].join(" "),
    ),
    date: normalizeSearchText(event.date),
  };
  return {
    event,
    fields,
    text: Object.values(fields).join(""),
  };
}

export function createEntitySearchDocument(entity, entityType) {
  const fields = {
    label: normalizeSearchText(entity.label),
    aliases: normalizeSearchText((entity.aliases ?? []).join(" ")),
    description: normalizeSearchText(entity.description),
    type: normalizeSearchText(
      [entity.type, entityType?.label, entityType?.description].join(" "),
    ),
  };
  return {
    entity,
    fields,
    text: Object.values(fields).join(""),
  };
}

export function matchesSearchDocument(document, parsedQuery) {
  return parsedQuery.every((alternatives) =>
    alternatives.some((alternative) => document.text.includes(alternative)),
  );
}

export function rankEventSearchDocument(document, query) {
  const phrase = normalizeSearchText(query);
  if (!phrase) return 0;
  const { fields } = document;
  let score = 0;
  if (fields.title === phrase) score += 100;
  else if (fields.title.includes(phrase)) score += 40;
  if (fields.summary.includes(phrase)) score += 16;
  if (fields.entities.includes(phrase)) score += 12;
  if (fields.types.includes(phrase)) score += 6;
  if (fields.source.includes(phrase)) score += 3;
  return score;
}

export function rankEntitySearchDocument(document, query) {
  const phrase = normalizeSearchText(query);
  if (!phrase) return 0;
  const { fields } = document;
  let score = 0;
  if (fields.label === phrase) score += 100;
  else if (fields.label.includes(phrase)) score += 40;
  if (fields.aliases.includes(phrase)) score += 24;
  if (fields.type.includes(phrase)) score += 8;
  if (fields.description.includes(phrase)) score += 3;
  return score;
}

function expandSearchTerm(value) {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const alternatives = new Set([normalized]);
  for (const group of normalizedSynonymGroups) {
    if (group.includes(normalized)) {
      group.forEach((item) => alternatives.add(item));
    }
  }
  for (const suffix of ADMINISTRATIVE_SUFFIXES) {
    const normalizedSuffix = normalizeSearchText(suffix);
    if (
      normalized.endsWith(normalizedSuffix) &&
      normalized.length > normalizedSuffix.length + 1
    ) {
      alternatives.add(normalized.slice(0, -normalizedSuffix.length));
      break;
    }
  }
  return [...alternatives];
}
