import { assertNumericExtractionConfig, assertReportingFormReviews } from "./report-description-extraction.mjs";
// Configuration is the only authority for topic names and extraction triggers.
// Fail closed on the old overloaded field instead of silently restoring aliases.
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nonempty = (value) => typeof value === "string" && value.trim().length > 0 && value === value.trim();
const actionAssert = (condition, path, message) => { if (!condition) throw new Error(`${path}: ${message}`); };
const actionShape = (value, keys, path) => actionAssert(object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), path, `must have exactly ${keys.join(", ")}`);
const actionTerms = (values, path, { empty = false } = {}) => actionAssert(Array.isArray(values) && (empty || values.length > 0) && values.every(nonempty) && new Set(values).size === values.length, path, "must contain unique non-empty literal strings");

// Template IDs identify implemented matching algorithms, not ontology labels.
// Semantic targets are checked against the authored ontology by the compiler.
const ACTION_TEMPLATES = ["legal_adjudication", "legal_prosecution", "engineering_lifecycle", "quantitative_change"];
const ACTION_QUALIFIERS = { polarity: ["negated", "undetermined"], modality: ["planned", "predicted", "conditional", "undetermined"] };

export function assertActionExtractionConfig(config, ontology) {
  const path = "actionExtraction";
  actionShape(config, ["version", "normalizationVersion", "rules", "qualifierCues", "reviewedAssessments"], path);
  actionAssert(config.version === "1.0.0", `${path}.version`, "unsupported action extraction contract");
  actionAssert(config.normalizationVersion === "visible-fragment-v1", `${path}.normalizationVersion`, "unsupported evidence normalization");
  for (const key of ["rules", "qualifierCues", "reviewedAssessments"]) actionAssert(Array.isArray(config[key]), `${path}.${key}`, "must be an array");
  actionAssert(config.rules.length > 0, `${path}.rules`, "must not be empty");
  const ids = new Set();
  const semanticRules = new Set();
  const claimId = (entry, entryPath) => {
    actionAssert(nonempty(entry.id) && /^[a-z][a-z0-9_-]*$/u.test(entry.id) && !ids.has(entry.id), `${entryPath}.id`, "must be stable and globally unique");
    ids.add(entry.id);
  };
  const nodes = ontology ? new Map(ontology.hierarchies?.action?.nodes?.map((node) => [node.id, node]) ?? []) : null;
  const templates = ontology ? new Map(ontology.actionAssessment?.templates?.map((template) => [template.id, template.conceptId]) ?? []) : null;
  for (const [index, rule] of config.rules.entries()) {
    const rulePath = `${path}.rules.${index}`;
    actionShape(rule, ["id", "conceptId", "template", "predicates", "contextTerms", "exclusions"], rulePath);
    claimId(rule, rulePath);
    actionAssert(nonempty(rule.conceptId) && /^[a-z][a-z0-9_-]*$/u.test(rule.conceptId), `${rulePath}.conceptId`, "must reference a stable concept ID");
    actionAssert(ACTION_TEMPLATES.includes(rule.template), `${rulePath}.template`, "unknown action template");
    for (const key of ["predicates", "contextTerms", "exclusions"]) actionTerms(rule[key], `${rulePath}.${key}`, { empty: key === "exclusions" });
    const signature = JSON.stringify([rule.conceptId, rule.template, [...rule.predicates].sort(), [...rule.contextTerms].sort(), [...rule.exclusions].sort()]);
    actionAssert(!semanticRules.has(signature), rulePath, "duplicate matching rule");
    semanticRules.add(signature);
    if (nodes) {
      const node = nodes.get(rule.conceptId);
      actionAssert(node?.status === "active" && node.abstract === false, `${rulePath}.conceptId`, "must target an active concrete action or state-change concept");
      actionAssert(templates.get(rule.template) === rule.conceptId, `${rulePath}.conceptId`, "template does not support this action concept");
    }
  }
  const qualifierValues = new Set();
  const qualifierTerms = new Set();
  for (const [index, cue] of config.qualifierCues.entries()) {
    const cuePath = `${path}.qualifierCues.${index}`;
    actionShape(cue, ["id", "kind", "value", "terms"], cuePath);
    claimId(cue, cuePath);
    actionAssert(Object.hasOwn(ACTION_QUALIFIERS, cue.kind) && ACTION_QUALIFIERS[cue.kind].includes(cue.value), cuePath, "unsupported qualifier kind or value");
    actionTerms(cue.terms, `${cuePath}.terms`);
    const key = `${cue.kind}:${cue.value}`;
    actionAssert(!qualifierValues.has(key), cuePath, "duplicate qualifier kind/value");
    qualifierValues.add(key);
    for (const term of cue.terms) {
      const termKey = `${cue.kind}:${term}`;
      actionAssert(!qualifierTerms.has(termKey), cuePath, "ambiguous duplicate qualifier term");
      qualifierTerms.add(termKey);
    }
  }
  const newsIds = new Set();
  for (const [index, review] of config.reviewedAssessments.entries()) {
    const reviewPath = `${path}.reviewedAssessments.${index}`;
    actionShape(review, ["id", "newsId", "fragmentHash", "status", "reviewedAt", "reason", "evidence"], reviewPath);
    claimId(review, reviewPath);
    actionAssert(/^news-[a-f0-9]{12}$/u.test(review.newsId ?? "") && !newsIds.has(review.newsId), `${reviewPath}.newsId`, "must be a unique news identity");
    newsIds.add(review.newsId);
    actionAssert(/^[a-f0-9]{64}$/u.test(review.fragmentHash ?? ""), `${reviewPath}.fragmentHash`, "must be an exact SHA-256 anchor");
    actionAssert(review.status === "not_applicable", `${reviewPath}.status`, "only reviewed not_applicable assessments are supported");
    const date = typeof review.reviewedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(review.reviewedAt) ? new Date(review.reviewedAt) : null;
    actionAssert(date && !Number.isNaN(date.valueOf()) && date.toISOString() === review.reviewedAt.replace(/(?<!\.\d{3})Z$/u, ".000Z"), `${reviewPath}.reviewedAt`, "must be a valid ISO UTC timestamp");
    actionAssert(nonempty(review.reason), `${reviewPath}.reason`, "must explain the reviewed assessment");
    actionShape(review.evidence, ["start", "end", "text"], `${reviewPath}.evidence`);
    const { start, end, text } = review.evidence;
    actionAssert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && nonempty(text) && text.length === end - start, `${reviewPath}.evidence`, "must anchor a non-empty exact UTF-16 span");
  }
  return config;
}

export function assertExtractionRules(rules) {
  if (!/^\d+\.\d+\.\d+$/u.test(rules.version ?? "")) {
    throw new Error("extraction-rules.version must be an explicit semantic version");
  }
  if (!Array.isArray(rules.topics) || !rules.topics.length) {
    throw new Error("extraction-rules.topics must be a non-empty array");
  }
  const ids = new Set();
  const entityIds = new Set();
  const labels = new Set();
  for (const [index, topic] of rules.topics.entries()) {
    const path = `topics.${index}`;
    if (!topic.id || ids.has(topic.id) || !topic.label?.trim() || labels.has(topic.label)) {
      throw new Error(`${path} must have a unique id and label`);
    }
    if (!/^entity-topic-[a-f0-9]+$/u.test(topic.entityId ?? "") || entityIds.has(topic.entityId) || !topic.conceptId || !rules.topicEventTypes?.[topic.id]) {
      throw new Error(`${path} must reference a unique pinned topic entity, concept and legacy domain`);
    }
    entityIds.add(topic.entityId);
    ids.add(topic.id);
    labels.add(topic.label);
    if (Object.hasOwn(topic, "keywords")) {
      throw new Error(`${path}.keywords is obsolete; use extractionTriggers and reviewed aliases separately`);
    }
    for (const field of ["aliases", "extractionTriggers"]) {
      const values = topic[field];
      if (!Array.isArray(values) || values.some((value) =>
        typeof value !== "string" || !value.trim() || value !== value.trim()) ||
        new Set(values).size !== values.length) {
        throw new Error(`${path}.${field} must contain unique non-empty strings`);
      }
    }
    if (!topic.extractionTriggers.length) {
      throw new Error(`${path}.extractionTriggers must not be empty`);
    }
  }
  for (const links of Object.values(rules.reviewedNewsEntityLinks ?? {})) {
    if (!Array.isArray(links)) throw new Error("Reviewed news links must be arrays");
    for (const link of links) {
      if (link.type !== "topic") continue;
      const topic = rules.topics.find((topic) => topic.conceptId === link.conceptId);
      if (!topic || link.label !== topic.label || link.entityId !== topic.entityId || JSON.stringify(link.aliases) !== JSON.stringify(topic.aliases)) throw new Error("Reviewed topic links must use the compiled stable concept and entity identity");
    }
  }
  if (Object.hasOwn(rules, "numericExtraction") || Object.hasOwn(rules, "reportingFormReviews")) {
    assertNumericExtractionConfig(rules.numericExtraction);
    assertReportingFormReviews(rules.reportingFormReviews);
  }
  // Historical pre-action rule artifacts remain readable during reviewed migration.
  if (Object.hasOwn(rules, "actionExtraction")) assertActionExtractionConfig(rules.actionExtraction);
}
