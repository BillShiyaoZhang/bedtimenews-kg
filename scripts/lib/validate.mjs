export function validate(kg, ontology) {
  const issues = [];
  const entityTypes = new Set(ontology.entityTypes.map((item) => item.id));
  const eventTypes = new Set(ontology.eventTypes.map((item) => item.id));
  const relationTypes = new Set(
    ontology.relationTypes.map((item) => item.id),
  );
  const entityIds = uniqueIds(kg.entities, "entities", issues);
  const eventIds = uniqueIds(kg.events, "events", issues);
  const sourceIds = uniqueIds(kg.sources, "sources", issues);
  uniqueIds(ontology.entityTypes, "ontology.entityTypes", issues);
  uniqueIds(ontology.eventTypes, "ontology.eventTypes", issues);
  uniqueIds(ontology.relationTypes, "ontology.relationTypes", issues);

  kg.entities.forEach((entity, index) => {
    if (!entityTypes.has(entity.type)) {
      issues.push(error(`entities.${index}.type`, `未知实体类型：${entity.type}`));
    }
  });

  kg.events.forEach((event, index) => {
    if (!eventTypes.has(event.type)) {
      issues.push(error(`events.${index}.type`, `未知事件类型：${event.type}`));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) {
      issues.push(error(`events.${index}.date`, `非法日期：${event.date}`));
    }
    for (const entityId of event.entityIds ?? []) {
      if (!entityIds.has(entityId)) {
        issues.push(
          error(
            `events.${index}.entityIds`,
            `引用了不存在的实体：${entityId}`,
          ),
        );
      }
    }
    for (const sourceId of event.sourceIds ?? []) {
      if (!sourceIds.has(sourceId)) {
        issues.push(
          error(
            `events.${index}.sourceIds`,
            `引用了不存在的来源：${sourceId}`,
          ),
        );
      }
    }
  });

  for (const [collection, nodeIds] of [
    ["eventRelations", eventIds],
    ["entityRelations", entityIds],
  ]) {
    uniqueIds(kg[collection], collection, issues);
    kg[collection].forEach((relation, index) => {
      if (!relationTypes.has(relation.type)) {
        issues.push(
          error(
            `${collection}.${index}.type`,
            `未知关系类型：${relation.type}`,
          ),
        );
      }
      if (!nodeIds.has(relation.from) || !nodeIds.has(relation.to)) {
        issues.push(
          error(
            `${collection}.${index}`,
            `关系端点不存在：${relation.from} → ${relation.to}`,
          ),
        );
      }
      if (!relation.evidence?.trim()) {
        issues.push(
          error(`${collection}.${index}.evidence`, "关系缺少证据说明"),
        );
      }
      if (!sourceIds.has(relation.sourceId)) {
        issues.push(
          error(
            `${collection}.${index}.sourceId`,
            `关系来源不存在：${relation.sourceId}`,
          ),
        );
      }
    });
  }

  return issues;
}

function uniqueIds(records, path, issues) {
  const ids = new Set();
  records.forEach((record, index) => {
    if (!record.id) {
      issues.push(error(`${path}.${index}.id`, "ID 不能为空"));
    } else if (ids.has(record.id)) {
      issues.push(error(`${path}.${index}.id`, `重复 ID：${record.id}`));
    }
    ids.add(record.id);
  });
  return ids;
}

function error(path, message) {
  return { level: "error", path, message };
}
