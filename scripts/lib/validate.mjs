export function validate(kg, ontology) {
  const issues = [];
  if (ontology.recordUnit?.id !== "news") {
    issues.push(error("ontology.recordUnit.id", "本体基本单位必须是独立新闻"));
  }
  const entityTypes = new Set(ontology.entityTypes.map((item) => item.id));
  const eventTypes = new Set(ontology.eventTypes.map((item) => item.id));
  const relationTypes = new Map(
    ontology.relationTypes.map((item) => [item.id, item]),
  );
  const validRelationNodeTypes = new Set(["event", ...entityTypes]);
  const entityIds = uniqueIds(kg.entities, "entities", issues);
  const eventIds = uniqueIds(kg.events, "events", issues);
  const sourceIds = uniqueIds(kg.sources, "sources", issues);
  const newsIds = new Set();
  uniqueIds(ontology.entityTypes, "ontology.entityTypes", issues);
  uniqueIds(ontology.eventTypes, "ontology.eventTypes", issues);
  uniqueIds(ontology.relationTypes, "ontology.relationTypes", issues);
  uniqueIds(ontology.facets, "ontology.facets", issues);
  uniqueIds(
    ontology.eventEntityRoles,
    "ontology.eventEntityRoles",
    issues,
  );

  if (ontology.eventEntityConstraint?.minimumEntities !== 1) {
    issues.push(
      error(
        "ontology.eventEntityConstraint.minimumEntities",
        "每条事件必须至少关联一个语义实体",
      ),
    );
  }
  const rolesById = new Map(
    ontology.eventEntityRoles.map((role) => [role.id, role]),
  );
  const roleMembership = new Map();
  ontology.eventEntityRoles.forEach((role, index) => {
    if (!role.description?.trim()) {
      issues.push(
        error(
          `ontology.eventEntityRoles.${index}.description`,
          "语义角色必须说明判断标准",
        ),
      );
    }
    for (const type of role.entityTypes ?? []) {
      if (!entityTypes.has(type)) {
        issues.push(
          error(
            `ontology.eventEntityRoles.${index}.entityTypes`,
            `语义角色引用了未知实体类型：${type}`,
          ),
        );
      }
      roleMembership.set(type, (roleMembership.get(type) ?? 0) + 1);
    }
  });
  for (const type of entityTypes) {
    if (roleMembership.get(type) !== 1) {
      issues.push(
        error(
          "ontology.eventEntityRoles",
          `实体类型 ${type} 必须恰好属于一个事件语义角色`,
        ),
      );
    }
  }
  ontology.facets.forEach((facet, index) => {
    for (const type of facet.entityTypes ?? []) {
      if (!entityTypes.has(type)) {
        issues.push(
          error(
            `ontology.facets.${index}.entityTypes`,
            `Facet 引用了未知实体类型：${type}`,
          ),
        );
      }
    }
    if (facet.entityTypes) {
      const role = rolesById.get(facet.id);
      if (
        !role ||
        JSON.stringify(role.entityTypes) !== JSON.stringify(facet.entityTypes)
      ) {
        issues.push(
          error(
            `ontology.facets.${index}`,
            "实体 Facet 必须具有类型完全一致的事件语义角色",
          ),
        );
      }
    }
  });
  ontology.relationTypes.forEach((relation, index) => {
    if (!relation.from?.length || !relation.to?.length) {
      issues.push(
        error(
          `ontology.relationTypes.${index}`,
          "关系必须声明非空的 domain 与 range",
        ),
      );
    }
    for (const type of [...(relation.from ?? []), ...(relation.to ?? [])]) {
      if (!validRelationNodeTypes.has(type)) {
        issues.push(
          error(
            `ontology.relationTypes.${index}`,
            `关系引用了未知端点类型：${type}`,
          ),
        );
      }
    }
  });

  const entityTypeById = new Map();
  kg.entities.forEach((entity, index) => {
    entityTypeById.set(entity.id, entity.type);
    if (!entityTypes.has(entity.type)) {
      issues.push(error(`entities.${index}.type`, `未知实体类型：${entity.type}`));
    }
  });

  kg.events.forEach((event, index) => {
    if (!event.newsId?.startsWith("news-")) {
      issues.push(
        error(
          `events.${index}.newsId`,
          "事件必须引用 processed news dataset 中的独立新闻 ID",
        ),
      );
    } else if (newsIds.has(event.newsId)) {
      issues.push(
        error(`events.${index}.newsId`, `重复新闻投影：${event.newsId}`),
      );
    }
    newsIds.add(event.newsId);
    if (!eventTypes.has(event.type)) {
      issues.push(error(`events.${index}.type`, `未知事件类型：${event.type}`));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) {
      issues.push(error(`events.${index}.date`, `非法日期：${event.date}`));
    }
    if (
      (event.entityIds?.length ?? 0) <
      ontology.eventEntityConstraint.minimumEntities
    ) {
      issues.push(
        error(
          `events.${index}.entityIds`,
          "事件未满足最小语义实体约束",
        ),
      );
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
    if (event.sourceIds?.length !== 1) {
      issues.push(
        error(
          `events.${index}.sourceIds`,
          "一条新闻必须精确引用一个原始页面；跨来源聚合应建立独立事实簇",
        ),
      );
    }
  });

  for (const [collection, nodeIds] of [
    ["eventRelations", eventIds],
    ["entityRelations", entityIds],
  ]) {
    uniqueIds(kg[collection], collection, issues);
    kg[collection].forEach((relation, index) => {
      const definition = relationTypes.get(relation.type);
      if (!definition) {
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
      if (definition) {
        const fromType =
          collection === "eventRelations"
            ? "event"
            : entityTypeById.get(relation.from);
        const toType =
          collection === "eventRelations"
            ? "event"
            : entityTypeById.get(relation.to);
        if (
          !fromType ||
          !toType ||
          !definition.from.includes(fromType) ||
          !definition.to.includes(toType)
        ) {
          issues.push(
            error(
              `${collection}.${index}`,
              "关系实例不满足 ontology 声明的 domain/range",
            ),
          );
        }
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
