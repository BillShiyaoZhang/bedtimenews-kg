// The same hierarchy contract is used by the compiler, validators and browser.
// Parents express class subsumption or topic broader terms, never part_of.
export function sameOntologyCompilation(left, right) {
  const keys = ["formatVersion", "compilerVersion", "sourceHash", "patternsHash"];
  return Boolean(left && right && Object.keys(left).length === keys.length && Object.keys(right).length === keys.length && keys.every((key) => Object.hasOwn(left, key) && Object.hasOwn(right, key) && left[key] === right[key]));
}

/** @returns {Array<{level: "error", path: string, message: string}>} */
export function validateHierarchy(hierarchy, path = "hierarchy") {
  const issues = [];
  const error = (suffix, message) => issues.push({ level: "error", path: `${path}.${suffix}`, message });
  if (!hierarchy || !["subClassOf", "broaderTopic"].includes(hierarchy.relation) || !Array.isArray(hierarchy.nodes)) {
    error("nodes", "层级必须声明关系和节点数组");
    return issues;
  }
  const nodes = new Map();
  for (const [index, node] of hierarchy.nodes.entries()) {
    if (!node || typeof node.id !== "string" || !/^[a-z][a-z0-9_-]*$/u.test(node.id) || nodes.has(node.id)) {
      error(`nodes.${index}.id`, "概念 ID 必须稳定、非空且唯一");
      continue;
    }
    nodes.set(node.id, node);
    if (typeof node.label !== "string" || !node.label.trim() || typeof node.description !== "string" || !node.description.trim()) error(`nodes.${index}`, "概念必须有名称和语义定义");
    for (const field of ["aliases", "parentIds"]) {
      if (!Array.isArray(node[field]) || node[field].some((value) => typeof value !== "string" || !value.trim() || value !== value.trim()) || new Set(node[field]).size !== node[field].length) error(`nodes.${index}.${field}`, "必须是非空值且不重复的字符串数组");
    }
    if (!["active", "draft", "deprecated"].includes(node.status)) error(`nodes.${index}.status`, "概念必须声明 active、draft 或 deprecated 状态");
    if (node.id === hierarchy.rootId ? node.primaryParentId !== null : !Array.isArray(node.parentIds) || !node.parentIds.includes(node.primaryParentId)) error(`nodes.${index}.primaryParentId`, "主导航父节点必须在 parentIds 中，根节点必须为 null");
    if (typeof node.abstract !== "boolean") error(`nodes.${index}.abstract`, "概念必须明确是否允许直接实例化");
  }
  if (!nodes.has(hierarchy.rootId)) error("rootId", "根节点不存在");
  for (const node of nodes.values()) {
    const parents = Array.isArray(node.parentIds) ? node.parentIds : [];
    if (node.id === hierarchy.rootId ? parents.length !== 0 : parents.length === 0) error(`nodes.${node.id}.parentIds`, "层级必须连通且只有一个根节点");
    for (const parent of parents) if (!nodes.has(parent)) error(`nodes.${node.id}.parentIds`, `未知父节点：${parent}`);
    if (node.status === "active" && parents.some((parent) => nodes.get(parent)?.status !== "active")) error(`nodes.${node.id}.status`, "活动概念的父节点必须活动");
  }
  const active = new Set();
  const done = new Set();
  function visit(id) {
    if (active.has(id)) { error(`nodes.${id}.parentIds`, "层级不能含有环"); return; }
    if (done.has(id) || !nodes.has(id)) return;
    active.add(id);
    for (const parent of Array.isArray(nodes.get(id).parentIds) ? nodes.get(id).parentIds : []) visit(parent);
    active.delete(id);
    done.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  return issues;
}

export function hierarchyIndex(hierarchy) {
  const issues = validateHierarchy(hierarchy);
  if (issues.length) throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  const byId = new Map(hierarchy.nodes.map((node) => [node.id, node]));
  const ancestors = {};
  const descendants = {};
  function collect(id) {
    if (ancestors[id]) return ancestors[id];
    const found = new Set();
    for (const parent of byId.get(id).parentIds) {
      found.add(parent);
      for (const ancestor of collect(parent)) found.add(ancestor);
    }
    return ancestors[id] = [...found].sort();
  }
  for (const id of byId.keys()) { collect(id); descendants[id] = []; }
  for (const [id, parents] of Object.entries(ancestors)) for (const parent of parents) descendants[parent].push(id);
  for (const values of Object.values(descendants)) values.sort();
  return { ancestors, descendants };
}

/** @returns {string[]} */
export function topicEntityIds(ontology, conceptId) {
  const hierarchy = ontology.hierarchies.topic;
  if (!Object.hasOwn(hierarchy.descendants, conceptId)) throw new Error(`Unknown topic concept: ${conceptId}`);
  const concepts = new Set([conceptId, ...hierarchy.descendants[conceptId]]);
  return ontology.mappings.topics.filter((mapping) => concepts.has(mapping.conceptId)).map((mapping) => mapping.entityId);
}

export function eventMatchesTopic(ontology, event, conceptId) {
  const ids = new Set(topicEntityIds(ontology, conceptId));
  return event.entityIds.some((id) => ids.has(id));
}

/** @returns {Array<{level: "error", path: string, message: string}>} */
export function validateCompiledHierarchy(ontology) {
  const issues = [];
  if (!["1.0.0", "1.1.0", "1.2.0"].includes(ontology.compilation?.compilerVersion) || ontology.compilation?.formatVersion !== 1 || ![ontology.compilation?.sourceHash, ontology.compilation?.patternsHash].every((hash) => /^[a-f0-9]{64}$/u.test(hash ?? ""))) issues.push({ level: "error", path: "compilation", message: "编译版本与输入指纹必须完整" });
  for (const kind of ["entity", "action", "topic"]) {
    const hierarchy = ontology.hierarchies?.[kind];
    const errors = validateHierarchy(hierarchy, `hierarchies.${kind}`);
    issues.push(...errors);
    if (!errors.length) {
      const expected = hierarchyIndex(hierarchy);
      for (const key of ["ancestors", "descendants"]) {
        if (JSON.stringify(hierarchy[key]) !== JSON.stringify(expected[key])) issues.push({ level: "error", path: `hierarchies.${kind}.${key}`, message: "编译层级索引与定义不一致" });
      }
    }
  }
  if (!issues.length) {
    const invalid = (path, message) => issues.push({ level: "error", path, message });
    const entities = new Map(ontology.hierarchies.entity.nodes.map((node) => [node.id, node]));
    const topics = new Map(ontology.hierarchies.topic.nodes.map((node) => [node.id, node]));
    for (const [kind, key] of [["entityTypes", "legacyId"], ["topics", "entityId"]]) {
      const mappings = ontology.mappings?.[kind];
      if (!Array.isArray(mappings) || !mappings.length || new Set(mappings.map((mapping) => mapping[key])).size !== mappings.length) {
        invalid(`mappings.${kind}`, "兼容映射必须完整且身份唯一");
        continue;
      }
      for (const mapping of mappings) {
        const valid = kind === "topics" ? topics.has(mapping.conceptId) && !topics.get(mapping.conceptId).abstract && topics.get(mapping.conceptId).status === "active" : mapping.legacyId === "topic" ? mapping.conceptKind === "TopicConcept" && !mapping.conceptId : entities.has(mapping.conceptId) && !entities.get(mapping.conceptId).abstract && entities.get(mapping.conceptId).status === "active";
        if (!valid) invalid(`mappings.${kind}`, "兼容映射引用了错误类型或未知概念");
      }
      if (kind === "entityTypes" && JSON.stringify(mappings.map((mapping) => mapping.legacyId)) !== JSON.stringify(ontology.entityTypes.map((type) => type.id))) invalid("mappings.entityTypes", "兼容实体类型映射不完整");
      if (kind === "topics" && (new Set(mappings.map((mapping) => mapping.conceptId)).size !== mappings.length || topics.size - ontology.hierarchies.topic.nodes.filter((node) => node.abstract).length !== mappings.length)) invalid("mappings.topics", "主题映射不完整");
    }
  }
  return issues;
}

// An inherited query match is derived; it never becomes a new evidence assertion.
/** @returns {Array<{conceptId: string, label: string, inherited: boolean}>} */
export function topicMatchReason(ontology, event, conceptId) {
  const entityIds = new Set(event.entityIds);
  const descendants = new Set(topicEntityIds(ontology, conceptId));
  const byId = new Map(ontology.hierarchies.topic.nodes.map((node) => [node.id, node]));
  return ontology.mappings.topics.filter((mapping) => descendants.has(mapping.entityId) && entityIds.has(mapping.entityId)).map((mapping) => ({
    conceptId: mapping.conceptId,
    label: byId.get(mapping.conceptId).label,
    inherited: mapping.conceptId !== conceptId,
  }));
}
