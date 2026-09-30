// Browser-safe structural checks and navigation. Only source replay can establish
// that these exact spans came from the hash-bound news fragment and matching rule.
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const stableId = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/u.test(value);
const nonempty = (value) => typeof value === "string" && Boolean(value.trim());
const vocabulary = {
  statuses: ["applicable", "not_applicable", "undetermined"],
  polarities: ["affirmative", "negated", "undetermined"],
  modalities: ["reported", "planned", "predicted", "conditional", "undetermined"],
  reasonCodes: ["supported_description", "reviewed_not_applicable", "no_supported_rule", "no_visible_body", "ambiguous_scope", "insufficient_context", "excluded_context"],
};
const unknownReasons = vocabulary.reasonCodes.filter((id) => !["supported_description", "reviewed_not_applicable"].includes(id));
const timestamp = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value.replace(/(?<!\.\d{3})Z$/u, ".000Z");
};
const tupleKey = (assignment) => JSON.stringify([assignment.conceptId, assignment.polarity, assignment.modality]);

/** @returns {Array<{level: "error", path: string, message: string}>} */
export function validateActionAssessment(assessment, ontology, path = "actionAssessment") {
  const issues = [];
  const error = (suffix, message) => issues.push({ level: "error", path: suffix ? `${path}.${suffix}` : path, message });
  if (!exact(assessment, ["status", "reasonCode", "assignments", "review"])) {
    error("", "行动评估必须只包含 status、reasonCode、assignments 和 review");
    return issues;
  }
  if (!vocabulary.statuses.includes(assessment.status)) error("status", "未知行动评估状态");
  if (!vocabulary.reasonCodes.includes(assessment.reasonCode)) error("reasonCode", "未知行动评估原因");
  if (!Array.isArray(assessment.assignments)) { error("assignments", "行动分配必须是数组"); return issues; }
  if (assessment.status === "applicable" && (!assessment.assignments.length || assessment.reasonCode !== "supported_description" || assessment.review !== null)) error("", "有证据描述必须包含分配、支持原因且不能带不适用审查");
  if (assessment.status === "undetermined" && (assessment.assignments.length || !unknownReasons.includes(assessment.reasonCode) || assessment.review !== null)) error("", "尚未确定不能包含行动分配或不适用审查");
  if (assessment.status === "not_applicable" && (assessment.assignments.length || assessment.reasonCode !== "reviewed_not_applicable" || assessment.review === null)) error("", "不适用必须有明确审查，不能由未命中规则推断");
  const span = (value, suffix, keys = ["start", "end", "text"]) => {
    const valid = exact(value, keys) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.end > value.start && nonempty(value.text) && value.text.length === value.end - value.start;
    if (!valid) error(suffix, "证据必须是非空、精确长度的 UTF-16 整数区间");
    return valid;
  };
  const contained = (inner, outer, suffix) => {
    if (inner.start < outer.start || inner.end > outer.end || outer.text.slice(inner.start - outer.start, inner.end - outer.start) !== inner.text) error(suffix, "谓词或限定证据必须包含在局部范围中且文字逐字一致");
  };
  if (assessment.review !== null) {
    const review = assessment.review;
    if (!exact(review, ["id", "reviewedAt", "reason", "evidence"])) error("review", "审查必须只包含身份、时间、理由和原文证据");
    else {
      if (!stableId(review.id)) error("review.id", "审查 ID 必须稳定且非空");
      if (!timestamp(review.reviewedAt)) error("review.reviewedAt", "审查时间必须是有效的 UTC ISO 时间");
      if (!nonempty(review.reason)) error("review.reason", "审查必须有明确理由");
      span(review.evidence, "review.evidence");
    }
    if (assessment.status !== "not_applicable") error("review", "只有不适用评估可以带审查");
  }
  const actionNodes = ontology?.hierarchies?.action?.nodes;
  const nodes = new Map(Array.isArray(actionNodes) ? actionNodes.filter(object).map((node) => [node.id, node]) : []);
  const assignments = new Set();
  const witnesses = new Set();
  const scopes = [];
  for (const [index, assignment] of assessment.assignments.entries()) {
    const assignmentPath = `assignments.${index}`;
    if (!exact(assignment, ["conceptId", "polarity", "modality", "evidence"])) { error(assignmentPath, "行动分配包含未知字段或缺少字段"); continue; }
    const node = nodes.get(assignment.conceptId);
    if (!node || node.status !== "active" || node.abstract) error(`${assignmentPath}.conceptId`, "只能分配活动且具体的行动或变化概念");
    if (!vocabulary.polarities.includes(assignment.polarity)) error(`${assignmentPath}.polarity`, "未知行动极性");
    if (!vocabulary.modalities.includes(assignment.modality)) error(`${assignmentPath}.modality`, "未知行动模态");
    const key = tupleKey(assignment);
    if (assignments.has(key)) error(assignmentPath, "重复的行动、极性与模态分配");
    assignments.add(key);
    if (!Array.isArray(assignment.evidence) || !assignment.evidence.length) { error(`${assignmentPath}.evidence`, "行动分配必须包含证据"); continue; }
    for (const [evidenceIndex, evidence] of assignment.evidence.entries()) {
      const evidencePath = `${assignmentPath}.evidence.${evidenceIndex}`;
      if (!exact(evidence, ["ruleId", "predicate", "scope", "qualifiers"])) { error(evidencePath, "行动证据包含未知字段或缺少字段"); continue; }
      if (!stableId(evidence.ruleId)) error(`${evidencePath}.ruleId`, "证据必须引用稳定规则 ID");
      const validPredicate = span(evidence.predicate, `${evidencePath}.predicate`);
      const validScope = span(evidence.scope, `${evidencePath}.scope`);
      if (validPredicate && validScope) contained(evidence.predicate, evidence.scope, `${evidencePath}.predicate`);
      if (validScope) {
        for (const prior of scopes) {
          const start = Math.max(prior.start, evidence.scope.start);
          const end = Math.min(prior.end, evidence.scope.end);
          if (start < end && prior.text.slice(start - prior.start, end - prior.start) !== evidence.scope.text.slice(start - evidence.scope.start, end - evidence.scope.start)) error(`${evidencePath}.scope`, "同一新闻的重叠证据范围必须逐字一致");
        }
        scopes.push(evidence.scope);
      }
      if (validPredicate) {
        const evidenceKey = JSON.stringify([assignment.conceptId, evidence.ruleId, evidence.predicate.start, evidence.predicate.end]);
        if (witnesses.has(evidenceKey)) error(evidencePath, "同一行动谓词的规则证据不能重复或赋予矛盾限定");
        witnesses.add(evidenceKey);
      }
      if (!Array.isArray(evidence.qualifiers)) { error(`${evidencePath}.qualifiers`, "限定证据必须是数组"); continue; }
      const qualifiers = new Set();
      for (const [qualifierIndex, qualifier] of evidence.qualifiers.entries()) {
        const qualifierPath = `${evidencePath}.qualifiers.${qualifierIndex}`;
        if (!span(qualifier, qualifierPath, ["kind", "value", "start", "end", "text"])) continue;
        if (validScope) contained(qualifier, evidence.scope, qualifierPath);
        const qualifierKey = JSON.stringify([qualifier.kind, qualifier.start, qualifier.end]);
        if (qualifiers.has(qualifierKey)) error(qualifierPath, "同一种限定的证据区间不能重复");
        qualifiers.add(qualifierKey);
        const values = qualifier.kind === "polarity" ? ["negated", "undetermined"] : qualifier.kind === "modality" ? ["planned", "predicted", "conditional", "undetermined"] : [];
        if (!values.includes(qualifier.value) || assignment[qualifier.kind] !== qualifier.value) error(qualifierPath, "限定类型、取值和所属分配必须一致");
      }
      for (const [kind, defaultValue] of [["polarity", "affirmative"], ["modality", "reported"]]) {
        if (assignment[kind] !== defaultValue && !evidence.qualifiers.some((qualifier) => qualifier?.kind === kind && qualifier.value === assignment[kind])) error(`${evidencePath}.qualifiers`, "非默认极性或模态必须在每条证据中有明确限定");
      }
    }
  }
  return issues;
}

/** @returns {Array<{level: "error", path: string, message: string}>} */
export function validateActionAssessmentStructure(kg, ontology) {
  const issues = [];
  const error = (path, message) => issues.push({ level: "error", path, message });
  const contract = ontology?.compilation?.compilerVersion === "1.1.0" || Boolean(ontology?.actionAssessment);
  const metadata = ontology?.actionAssessment;
  if (contract) {
    if (!metadata || metadata.schemaVersion !== 1 || metadata.normalizationVersion !== "visible-fragment-v1") error("actionAssessment", "本体必须声明受支持的行动评估与证据坐标版本");
    for (const [key, values] of Object.entries(vocabulary)) {
      const entries = metadata?.[key];
      if (!Array.isArray(entries) || entries.length !== values.length || new Set(entries.map((entry) => entry?.id)).size !== values.length || entries.some((entry) => !exact(entry, ["id", "label", "description"]) || !values.includes(entry.id) || !nonempty(entry.label) || !nonempty(entry.description))) error(`actionAssessment.${key}`, "本体必须定义完整、唯一的评估显示词表");
    }
    if (kg?.source?.actionExtractionVersion !== "1.0.0") error("source.actionExtractionVersion", "KG 必须声明受支持的行动抽取版本");
    if (kg?.source?.actionNormalizationVersion !== metadata?.normalizationVersion) error("source.actionNormalizationVersion", "KG 与本体的行动证据坐标版本必须一致");
  } else if (kg?.source?.actionExtractionVersion !== undefined || kg?.source?.actionNormalizationVersion !== undefined) error("source.actionExtractionVersion", "历史本体不能混入无对应定义的行动数据");
  if (!Array.isArray(kg?.events)) { error("events", "行动评估必须依附于新闻事件数组"); return issues; }
  for (const [index, event] of kg.events.entries()) {
    const path = `events.${index}.actionAssessment`;
    if (!object(event)) { error(path, "行动评估必须依附于独立新闻对象"); continue; }
    if (contract || event.actionAssessment !== undefined) issues.push(...validateActionAssessment(event.actionAssessment, ontology, path));
    if (!contract && event.actionAssessment !== undefined) error(path, "历史本体未声明行动评估契约");
  }
  return issues;
}

export function actionAssessmentLabel(ontology, group, id) {
  return ontology.actionAssessment?.[group]?.find((entry) => entry.id === id)?.label ?? id;
}

function checkedFilter(ontology, filter) {
  if (!object(filter) || Object.keys(filter).some((key) => !["conceptId", "status", "polarity", "modality"].includes(key))) throw new Error("Unknown action filter field");
  if (Object.values(filter).some((value) => value !== undefined && typeof value !== "string")) throw new Error("Action filter values must be strings");
  for (const [key, group] of [["status", "statuses"], ["polarity", "polarities"], ["modality", "modalities"]]) if (filter[key] && !vocabulary[group].includes(filter[key])) throw new Error(`Unknown action filter ${key}`);
  const nodes = ontology.hierarchies.action.nodes;
  const node = filter.conceptId ? nodes.find((entry) => entry.id === filter.conceptId) : null;
  if (filter.conceptId && !node) throw new Error(`Unknown action concept: ${filter.conceptId}`);
  return { node, concepts: node ? new Set([node.id, ...ontology.hierarchies.action.descendants[node.id]]) : null };
}

// Every class/qualifier condition applies to the same assignment. Traversing an
// ancestor is a query explanation, never a new evidence or occurrence assertion.
/** @returns {Array<{conceptId: string, label: string, inherited: boolean, polarity: string, modality: string, evidence: Array}>} */
export function actionMatchReasons(ontology, event, filter = {}) {
  const { node, concepts } = checkedFilter(ontology, filter);
  const assessment = event.actionAssessment;
  if (!assessment || assessment.status !== "applicable" || !Array.isArray(assessment.assignments) || filter.status && assessment.status !== filter.status || node?.status !== "active" && node) return [];
  const seen = new Set();
  return assessment.assignments.filter((assignment) => {
    if (concepts && !concepts.has(assignment.conceptId) || filter.polarity && assignment.polarity !== filter.polarity || filter.modality && assignment.modality !== filter.modality) return false;
    const key = tupleKey(assignment);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((assignment) => ({
    ...assignment,
    label: ontology.hierarchies.action.nodes.find((entry) => entry.id === assignment.conceptId)?.label ?? assignment.conceptId,
    inherited: Boolean(node && assignment.conceptId !== node.id),
  }));
}

export function eventMatchesAction(ontology, event, filter = {}) {
  checkedFilter(ontology, filter);
  if (!Object.values(filter).some(Boolean)) return true;
  if (filter.status && event.actionAssessment?.status !== filter.status) return false;
  if (!filter.conceptId && !filter.polarity && !filter.modality) return Boolean(event.actionAssessment);
  return actionMatchReasons(ontology, event, filter).length > 0;
}

export function actionNewsCount(ontology, events, conceptId, filter = {}) {
  return new Set(events.filter((event) => eventMatchesAction(ontology, event, { ...filter, conceptId })).map((event) => event.newsId)).size;
}

export function actionFilterOptions(ontology, events) {
  const hierarchy = ontology.hierarchies.action;
  const options = [];
  const visit = (id, depth) => {
    const node = hierarchy.nodes.find((entry) => entry.id === id);
    if (!node || node.status !== "active") return;
    const count = actionNewsCount(ontology, events, id);
    options.push({ id, label: `${"　".repeat(depth)}${node.label}${node.abstract ? "（含下级）" : ""} · ${count} 条新闻`, count, depth });
    for (const child of hierarchy.nodes.filter((entry) => entry.primaryParentId === id)) visit(child.id, depth + 1);
  };
  visit(hierarchy.rootId, 0);
  return options;
}
