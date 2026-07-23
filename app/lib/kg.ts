export type EntityType = {
  id: string;
  label: string;
  description: string;
  color: string;
};

export type EventType = EntityType;

export type RelationType = {
  id: string;
  label: string;
  description: string;
  from: string[];
  to: string[];
  directed: boolean;
};

export type Ontology = {
  version: string;
  label: string;
  description: string;
  entityTypes: EntityType[];
  eventTypes: EventType[];
  relationTypes: RelationType[];
};

export type Entity = {
  id: string;
  label: string;
  type: string;
  aliases: string[];
  description: string;
};

export type Event = {
  id: string;
  title: string;
  date: string;
  datePrecision: "day" | "month" | "year";
  type: string;
  summary: string;
  entityIds: string[];
  sourceIds: string[];
  significance: string;
};

export type Relation = {
  id: string;
  from: string;
  to: string;
  type: string;
  confidence?: number;
  evidence: string;
  sourceId: string;
};

export type Source = {
  id: string;
  title: string;
  archiveUrl: string;
  repositoryPath: string;
  repositoryUrl: string;
  publishedAt: string;
  kind: string;
};

export type KnowledgeBase = {
  schemaVersion: string;
  generatedAt: string;
  source: {
    name: string;
    url: string;
    licenseNote: string;
    mode: string;
  };
  entities: Entity[];
  events: Event[];
  eventRelations: Relation[];
  entityRelations: Relation[];
  sources: Source[];
};

export type ValidationIssue = {
  level: "error" | "warning";
  path: string;
  message: string;
};

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const hexColor = /^#[0-9a-f]{6}$/i;

export function validateOntology(ontology: Ontology): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const groups = [
    ["entityTypes", ontology.entityTypes],
    ["eventTypes", ontology.eventTypes],
    ["relationTypes", ontology.relationTypes],
  ] as const;

  for (const [groupName, values] of groups) {
    const ids = new Set<string>();
    values.forEach((value, index) => {
      if (!value.id.trim()) {
        issues.push({
          level: "error",
          path: `${groupName}.${index}.id`,
          message: "类型 ID 不能为空",
        });
      } else if (ids.has(value.id)) {
        issues.push({
          level: "error",
          path: `${groupName}.${index}.id`,
          message: `重复的类型 ID：${value.id}`,
        });
      }
      ids.add(value.id);
      if (!value.label.trim()) {
        issues.push({
          level: "error",
          path: `${groupName}.${index}.label`,
          message: "显示名称不能为空",
        });
      }
    });
  }

  ontology.entityTypes.forEach((type, index) => {
    if (!hexColor.test(type.color)) {
      issues.push({
        level: "error",
        path: `entityTypes.${index}.color`,
        message: "颜色必须使用六位十六进制格式",
      });
    }
  });

  ontology.eventTypes.forEach((type, index) => {
    if (!hexColor.test(type.color)) {
      issues.push({
        level: "error",
        path: `eventTypes.${index}.color`,
        message: "颜色必须使用六位十六进制格式",
      });
    }
  });

  ontology.relationTypes.forEach((type, index) => {
    if (type.from.length === 0 || type.to.length === 0) {
      issues.push({
        level: "error",
        path: `relationTypes.${index}`,
        message: "关系必须声明起点与终点类型",
      });
    }
    if (!type.description.trim()) {
      issues.push({
        level: "warning",
        path: `relationTypes.${index}.description`,
        message: "建议说明关系的判断标准",
      });
    }
  });

  return issues;
}

export function validateKnowledgeBase(
  kg: KnowledgeBase,
  ontology: Ontology,
): ValidationIssue[] {
  const issues = validateOntology(ontology);
  const entityIds = new Set<string>();
  const eventIds = new Set<string>();
  const sourceIds = new Set(kg.sources.map((source) => source.id));
  const entityTypeIds = new Set(ontology.entityTypes.map((type) => type.id));
  const eventTypeIds = new Set(ontology.eventTypes.map((type) => type.id));
  const relationTypes = new Map(
    ontology.relationTypes.map((type) => [type.id, type]),
  );

  kg.entities.forEach((entity, index) => {
    if (entityIds.has(entity.id)) {
      issues.push({
        level: "error",
        path: `entities.${index}.id`,
        message: `重复实体 ID：${entity.id}`,
      });
    }
    entityIds.add(entity.id);
    if (!entityTypeIds.has(entity.type)) {
      issues.push({
        level: "error",
        path: `entities.${index}.type`,
        message: `未知实体类型：${entity.type}`,
      });
    }
    if (!entity.description?.trim()) {
      issues.push({
        level: "warning",
        path: `entities.${index}.description`,
        message: `实体“${entity.label}”缺少消歧说明`,
      });
    }
  });

  kg.events.forEach((event, index) => {
    if (eventIds.has(event.id)) {
      issues.push({
        level: "error",
        path: `events.${index}.id`,
        message: `重复事件 ID：${event.id}`,
      });
    }
    eventIds.add(event.id);
    if (!eventTypeIds.has(event.type)) {
      issues.push({
        level: "error",
        path: `events.${index}.type`,
        message: `未知事件类型：${event.type}`,
      });
    }
    if (!isoDate.test(event.date)) {
      issues.push({
        level: "error",
        path: `events.${index}.date`,
        message: `日期不是 YYYY-MM-DD：${event.date}`,
      });
    }
    event.entityIds.forEach((id) => {
      if (!entityIds.has(id) && !kg.entities.some((entity) => entity.id === id)) {
        issues.push({
          level: "error",
          path: `events.${index}.entityIds`,
          message: `事件引用了不存在的实体：${id}`,
        });
      }
    });
    event.sourceIds.forEach((id) => {
      if (!sourceIds.has(id)) {
        issues.push({
          level: "error",
          path: `events.${index}.sourceIds`,
          message: `事件引用了不存在的来源：${id}`,
        });
      }
    });
  });

  const validateRelation = (
    relation: Relation,
    index: number,
    collection: "eventRelations" | "entityRelations",
  ) => {
    const definition = relationTypes.get(relation.type);
    if (!definition) {
      issues.push({
        level: "error",
        path: `${collection}.${index}.type`,
        message: `未知关系类型：${relation.type}`,
      });
    }
    const validNodeIds =
      collection === "eventRelations" ? eventIds : entityIds;
    if (!validNodeIds.has(relation.from) || !validNodeIds.has(relation.to)) {
      issues.push({
        level: "error",
        path: `${collection}.${index}`,
        message: `关系端点不存在：${relation.from} → ${relation.to}`,
      });
    }
    if (!relation.evidence?.trim()) {
      issues.push({
        level: "error",
        path: `${collection}.${index}.evidence`,
        message: "关系必须附带证据说明",
      });
    }
    if (!sourceIds.has(relation.sourceId)) {
      issues.push({
        level: "error",
        path: `${collection}.${index}.sourceId`,
        message: `关系来源不存在：${relation.sourceId}`,
      });
    }
  };

  kg.eventRelations.forEach((relation, index) =>
    validateRelation(relation, index, "eventRelations"),
  );
  kg.entityRelations.forEach((relation, index) =>
    validateRelation(relation, index, "entityRelations"),
  );

  return issues;
}

export function formatEventDate(event: Event) {
  if (event.datePrecision === "year") return event.date.slice(0, 4);
  if (event.datePrecision === "month") {
    const [year, month] = event.date.split("-");
    return `${year} 年 ${Number(month)} 月`;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${event.date}T00:00:00Z`));
}

export function relationLabel(ontology: Ontology, type: string) {
  return (
    ontology.relationTypes.find((relation) => relation.id === type)?.label ??
    type
  );
}

export function getEntityEvents(kg: KnowledgeBase, entityId: string) {
  return kg.events
    .filter((event) => event.entityIds.includes(entityId))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function getNeighborRelations(kg: KnowledgeBase, eventId: string) {
  return kg.eventRelations.filter(
    (relation) => relation.from === eventId || relation.to === eventId,
  );
}

export function getEventPath(
  kg: KnowledgeBase,
  startId: string,
  endId: string,
) {
  if (startId === endId) return [] as Relation[];
  const queue: Array<{ id: string; path: Relation[] }> = [
    { id: startId, path: [] },
  ];
  const visited = new Set([startId]);

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    const neighbors = kg.eventRelations.filter(
      (relation) =>
        relation.from === current.id || relation.to === current.id,
    );
    for (const relation of neighbors) {
      const nextId =
        relation.from === current.id ? relation.to : relation.from;
      if (visited.has(nextId)) continue;
      const nextPath = [...current.path, relation];
      if (nextId === endId) return nextPath;
      visited.add(nextId);
      queue.push({ id: nextId, path: nextPath });
    }
  }
  return [] as Relation[];
}

export function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
