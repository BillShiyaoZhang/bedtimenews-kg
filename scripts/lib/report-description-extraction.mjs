import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeActionFragment } from "./action-extraction.mjs";
import {
  REPORT_DESCRIPTION_NORMALIZATION_VERSION, REPORTED_NUMERIC_NAMESPACE_VERSION,
  REPORTING_FORM_IDS, canonicalReportedDecimal, isReportDescriptionSpan,
  isReportDescriptionTimestamp, validateReportingFormAssessment,
  validateNumericObservationAssessment,
} from "../../app/lib/report-description-assessment.mjs";

export { REPORT_DESCRIPTION_NORMALIZATION_VERSION, REPORTED_NUMERIC_NAMESPACE_VERSION };
export const REPORT_DESCRIPTION_EXTRACTION_VERSION = "1.0.0";
export const REPORT_DESCRIPTION_MAX_FRAGMENT_LENGTH = 65536;
export const REPORTED_NUMERIC_METRIC_TERMS = ["工业增加值", "营业收入", "全国居民消费价格", "越南服装出口额", "我国进出口总值", "民间固投"];
// Deliberately conservative whole-visible-fragment abstention. This fixed
// lexical inventory is a bounded heuristic, not complete language understanding:
// it intentionally rejects unrelated uses too rather than guessing cue scope.
// Hidden titles, links, comments and code are removed by the shared normalizer
// before this check. No punctuation or paragraph break clears a visible cue.
export const REPORT_DESCRIPTION_AMBIGUITY_CUES = Object.freeze([
  "预计", "预测", "预期", "计划", "打算", "力争", "争取", "目标",
  "假如", "如果", "假设", "倘若", "万一",
  "否认", "否定", "辟谣", "不实", "不属实", "并非事实", "尚未", "未实现",
  "传闻", "传言", "据传", "据说", "听说", "谣言",
  "可能", "或许", "也许", "疑似", "不确定", "存疑", "推测", "猜测",
  "有待证实", "尚待证实", "未经证实", "未获证实", "无法证实", "不能证实",
  "待核实", "未经核实", "未获核实", "无法核实",
  "声称", "宣称", "表示", "报道称", "据称", "据报道", "据悉", "据介绍", "据透露",
  "认为", "估计", "发言人说", "他说", "她说", "有人说",
]);
const AMBIGUOUS_FRAGMENT = new RegExp(REPORT_DESCRIPTION_AMBIGUITY_CUES.join("|"), "u");
const TEMPLATE = "standalone_relative_percent_change_v1";
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nonempty = (value) => typeof value === "string" && value.trim().length > 0 && value === value.trim();
const stableId = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,95}$/u.test(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const assert = (condition, path, message) => { if (!condition) throw new Error(`${path}: ${message}`); };
const shape = (value, keys, path) => assert(object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), path, `must have exactly ${keys.join(", ")}`);
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const span = (text, start, end) => ({ start, end, text: text.slice(start, end) });
const canonical = (value) => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort(compare).map((key) => [key, item[key]])) : item);

export function assertReportingFormConfig(config) {
  const path = "reportingForm";
  shape(config, ["schemaVersion", "normalizationVersion", "concepts"], path);
  assert(config.schemaVersion === 1 && config.normalizationVersion === REPORT_DESCRIPTION_NORMALIZATION_VERSION, path, "unsupported reporting-form contract or normalization");
  assert(Array.isArray(config.concepts) && config.concepts.length === REPORTING_FORM_IDS.length, `${path}.concepts`, "must define exactly the fixed reporting-form vocabulary");
  const ids = new Set();
  for (const [index, concept] of config.concepts.entries()) {
    const at = `${path}.concepts.${index}`;
    shape(concept, ["id", "label", "description", "status"], at);
    assert(REPORTING_FORM_IDS.includes(concept.id) && !ids.has(concept.id), `${at}.id`, "unknown or duplicate reporting-form concept");
    ids.add(concept.id);
    assert(nonempty(concept.label) && nonempty(concept.description), at, "label and description must be nonempty");
    assert(["active", "draft"].includes(concept.status), `${at}.status`, "unsupported concept status");
  }
  return config;
}
export function assertNumericObservationConfig(config) {
  shape(config, ["schemaVersion", "normalizationVersion", "namespaceVersion"], "numericObservation");
  assert(config.schemaVersion === 1 && config.normalizationVersion === REPORT_DESCRIPTION_NORMALIZATION_VERSION && config.namespaceVersion === REPORTED_NUMERIC_NAMESPACE_VERSION, "numericObservation", "unsupported numeric description contract");
  return config;
}
export function assertNumericExtractionConfig(config) {
  shape(config, ["version", "normalizationVersion", "rules"], "numericExtraction");
  assert(config.version === REPORT_DESCRIPTION_EXTRACTION_VERSION && config.normalizationVersion === REPORT_DESCRIPTION_NORMALIZATION_VERSION, "numericExtraction", "unsupported extraction contract");
  assert(Array.isArray(config.rules) && config.rules.length > 0 && config.rules.length <= 32, "numericExtraction.rules", "must contain between 1 and 32 rules");
  const ids = new Set();
  for (const [index, rule] of config.rules.entries()) {
    const at = `numericExtraction.rules.${index}`;
    shape(rule, ["id", "template", "metricTerms"], at);
    assert(stableId(rule.id) && !ids.has(rule.id), `${at}.id`, "must be stable and unique");
    ids.add(rule.id);
    assert(rule.template === TEMPLATE, `${at}.template`, "unsupported numeric template");
    assert(Array.isArray(rule.metricTerms) && rule.metricTerms.length > 0 && rule.metricTerms.every((term) => REPORTED_NUMERIC_METRIC_TERMS.includes(term)) && new Set(rule.metricTerms).size === rule.metricTerms.length, `${at}.metricTerms`, "must contain unique exact supported metric literals");
  }
  return config;
}
export function assertReportingFormReviews(reviews, reportingForm) {
  if (reportingForm !== undefined) assertReportingFormConfig(reportingForm);
  assert(Array.isArray(reviews), "reportingFormReviews", "must be an array");
  const ids = new Set();
  const newsIds = new Set();
  const concepts = reportingForm?.concepts ?? REPORTING_FORM_IDS.map((id) => ({ id, status: "active" }));
  for (const [index, review] of reviews.entries()) {
    const at = `reportingFormReviews.${index}`;
    shape(review, ["id", "newsId", "fragmentHash", "status", "reviewedAt", "reason", "evidence", "assignments"], at);
    assert(stableId(review.id) && !ids.has(review.id), `${at}.id`, "must be stable and unique");
    ids.add(review.id);
    assert(/^news-[a-f0-9]{12}$/u.test(review.newsId ?? "") && !newsIds.has(review.newsId), `${at}.newsId`, "one effective review per exact news identity is required");
    newsIds.add(review.newsId);
    assert(/^[a-f0-9]{64}$/u.test(review.fragmentHash ?? ""), `${at}.fragmentHash`, "must be an exact SHA-256 anchor");
    assert(isReportDescriptionTimestamp(review.reviewedAt), `${at}.reviewedAt`, "must be a valid explicit UTC timestamp");
    const assessment = reviewedAssessment(review);
    const issues = validateReportingFormAssessment(assessment, { concepts }, at);
    assert(issues.length === 0, at, issues.map((item) => `${item.path}: ${item.message}`).join("; "));
  }
  return reviews;
}
export function assertReportDescriptionConfig(config) {
  shape(config, ["reportingForm", "numericObservation", "reportingFormReviews", "numericExtraction"], "reportDescription");
  assertReportingFormConfig(config.reportingForm);
  assertNumericObservationConfig(config.numericObservation);
  assertNumericExtractionConfig(config.numericExtraction);
  assertReportingFormReviews(config.reportingFormReviews, config.reportingForm);
  return config;
}
function reviewedAssessment(review) {
  const { id, newsId, fragmentHash, reviewedAt, reason, evidence } = review;
  return {
    status: review.status,
    reasonCode: review.status === "applicable" ? "reviewed_description" : review.status === "not_applicable" ? "reviewed_not_applicable" : "reviewed_undetermined",
    assignments: structuredClone(review.assignments),
    review: structuredClone({ id, newsId, fragmentHash, reviewedAt, reason, evidence }),
  };
}
function assertContext(context) {
  shape(context, ["newsId", "fragmentHash"], "reportDescription.context");
  assert(/^news-[a-f0-9]{12}$/u.test(context.newsId ?? ""), "reportDescription.context.newsId", "requires an exact news identity");
  assert(/^[a-f0-9]{64}$/u.test(context.fragmentHash ?? ""), "reportDescription.context.fragmentHash", "requires the exact raw fragment SHA-256");
}
export function reportedNumericObservationId(observation, context) {
  assertContext(context);
  const evidence = observation.evidence;
  // Rule IDs are support provenance, never occurrence identity. This namespace
  // intentionally binds the input revision; it is not a cross-news fact key.
  return `reported-numeric-observation-${digest(canonical({
    namespaceVersion: REPORTED_NUMERIC_NAMESPACE_VERSION,
    newsId: context.newsId,
    fragmentHash: context.fragmentHash,
    normalizationVersion: evidence.normalizationVersion,
    scopeStart: evidence.scope.start, scopeEnd: evidence.scope.end,
    metricStart: evidence.metric.start, metricEnd: evidence.metric.end,
    valueStart: evidence.value.start, valueEnd: evidence.value.end,
    normalizedPayload: {
      metric: observation.metric, value: observation.value, comparison: observation.comparison,
      referencePeriod: observation.referencePeriod, populationOrPlace: observation.populationOrPlace,
      polarity: observation.polarity, modality: observation.modality, evidence,
    },
  }))}`;
}
function validateInput(raw, context) {
  assertContext(context);
  assert(typeof raw === "string" && raw.length <= REPORT_DESCRIPTION_MAX_FRAGMENT_LENGTH, "reportDescription.fragment", `must be a string of at most ${REPORT_DESCRIPTION_MAX_FRAGMENT_LENGTH} UTF-16 code units`);
  // Bound the existing shared normalizer's balanced-link scanning work without
  // changing its semantics or introducing another normalization implementation.
  assert((raw.match(/\[/gu) ?? []).length <= 256, "reportDescription.fragment", "exceeds bounded link-markup work");
  assert(digest(raw) === context.fragmentHash, "reportDescription.fragmentHash", "does not match the exact UTF-8 news fragment");
  return normalizeActionFragment(raw);
}
function exactEvidence(evidence, text) {
  assert(isReportDescriptionSpan(evidence, true) && evidence.end <= text.length && text.slice(evidence.start, evidence.end) === evidence.text, "reportingFormReviews.evidence", "must match the exact normalized visible UTF-16 fragment span");
}
// Newlines, commas, colons and semicolons are NOT boundaries. Splitting there
// would borrow a suffix from its governing forecast, denial or conditional.
function sentences(text) {
  const result = [];
  let start = 0;
  let atStartQuoted = false;
  const open = new Set(["“", "‘", "「", "『", "（", "("]);
  const close = new Set(["”", "’", "」", "』", "）", ")"]);
  let depth = 0;
  let asciiQuoted = false;
  let asciiSingleQuoted = false;
  function append(end) {
    let from = start;
    let to = end;
    while (from < to && /\s/u.test(text[from])) from += 1;
    while (to > from && /\s/u.test(text[to - 1])) to -= 1;
    if (to > from) result.push({ ...span(text, from, to), quoted: atStartQuoted });
    start = end;
    atStartQuoted = depth > 0 || asciiQuoted || asciiSingleQuoted;
  }
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (open.has(char)) depth += 1;
    if (close.has(char)) depth = Math.max(0, depth - 1);
    if (char === '"') asciiQuoted = !asciiQuoted;
    if (char === "'") asciiSingleQuoted = !asciiSingleQuoted;
    const boundary = /[。！？!?]/u.test(char) || char === "." && !(/[0-9]/u.test(text[at - 1] ?? "") && /[0-9]/u.test(text[at + 1] ?? ""));
    if (boundary) {
      while (at + 1 < text.length && /[。！？!?.]/u.test(text[at + 1])) at += 1;
      append(at + 1);
    }
  }
  append(text.length);
  return result;
}
const period = "(?:(?:[0-9]{4}年)?(?:[1-9]|1[0-2])月份?|(?:今年|去年)?前(?:[1-9]|1[0-2]|十一|十二|[一二两三四五六七八九十])个月|[0-9]{4}年(?:第?[一二三四]季度|上半年|下半年)?|(?:去年|今年|上月|本月|上季度|本季度|第?[一二三四]季度|上半年|下半年))";
function rulePattern(rule) {
  const metrics = [...rule.metricTerms].sort((a, b) => b.length - a.length || compare(a, b)).join("|");
  return new RegExp(`^(?:(?<period>${period})[ \\t]*(?:[，,的][ \\t]*)?)?(?<metric>${metrics})[ \\t]*(?<comparison>同比|环比)[ \\t]*(?<direction>增长|下降)[ \\t]*(?<value>[0-9]{1,32}(?:\\.[0-9]{1,32})?)[ \\t]*(?<unit>%|％)(?:[。.]|)$`, "du");
}
function rejectionReason(sentence, ambiguousFragment) {
  if (ambiguousFragment || sentence.quoted || /[？?“”‘’"「」『』，,：:；;\r\n]|预计|预测|预期|计划|假如|如果|假设|尚未|未实现|否认|可能|目标|声称|表示|称/u.test(sentence.text)) return "ambiguous_scope";
  return "excluded_context";
}
export function createReportDescriptionEngine(config) {
  assertReportDescriptionConfig(config);
  config = structuredClone(config);
  const rules = config.numericExtraction.rules.map((rule) => ({ ...rule, pattern: rulePattern(rule) })).sort((a, b) => compare(a.id, b.id));
  const reviews = new Map(config.reportingFormReviews.map((review) => [review.newsId, review]));
  function evaluate(raw, context) {
    const text = validateInput(raw, context);
    const ambiguousFragment = AMBIGUOUS_FRAGMENT.test(text);
    const review = reviews.get(context.newsId);
    let reportingFormAssessment = { status: "undetermined", reasonCode: "no_review", assignments: [], review: null };
    if (review) {
      assert(review.fragmentHash === context.fragmentHash, "reportingFormReviews.fragmentHash", `stale review ${review.id} for ${context.newsId}; explicit re-review or removal is required`);
      for (const evidence of [...review.evidence, ...review.assignments.flatMap((item) => item.evidence)]) exactEvidence(evidence, text);
      reportingFormAssessment = reviewedAssessment(review);
      reportingFormAssessment.assignments.sort((a, b) => compare(a.conceptId, b.conceptId));
      for (const evidence of [reportingFormAssessment.review.evidence, ...reportingFormAssessment.assignments.map((item) => item.evidence)]) evidence.sort((a, b) => a.start - b.start || a.end - b.end || compare(a.text, b.text));
    }
    const observations = new Map();
    const rejected = [];
    for (const sentence of sentences(text)) {
      let accepted = false;
      if (!ambiguousFragment && !sentence.quoted && sentence.text.length <= 1024) for (const rule of rules) {
        const match = rule.pattern.exec(sentence.text);
        if (!match) continue;
        let decimal;
        try { decimal = canonicalReportedDecimal(match.groups.value); } catch { continue; }
        const own = (key) => {
          const range = match.indices.groups[key];
          return range ? span(text, sentence.start + range[0], sentence.start + range[1]) : null;
        };
        const evidence = {
          normalizationVersion: REPORT_DESCRIPTION_NORMALIZATION_VERSION,
          scope: span(text, sentence.start, sentence.end), metric: own("metric"),
          comparison: own("comparison"), direction: own("direction"), value: own("value"), unit: own("unit"), referencePeriod: own("period"),
        };
        const observation = {
          metric: { text: evidence.metric.text, span: evidence.metric },
          value: { raw: match.groups.value, decimal, unit: "percent", measureKind: "relative_change", direction: match.groups.direction === "增长" ? "increase" : "decrease" },
          comparison: match.groups.comparison === "同比" ? "year_over_year" : "month_over_month",
          referencePeriod: evidence.referencePeriod ? { text: evidence.referencePeriod.text, span: evidence.referencePeriod } : null,
          populationOrPlace: null, polarity: "affirmative", modality: "reported", evidence,
        };
        const id = reportedNumericObservationId(observation, context);
        const existing = observations.get(id);
        if (existing) {
          const { id: ignoredId, ruleIds: ignoredRules, ...payload } = existing;
          void ignoredId; void ignoredRules;
          assert(isDeepStrictEqual(payload, observation), "numericObservation.id", "hash collision or conflicting payload under one observation ID");
          existing.ruleIds.push(rule.id);
        } else observations.set(id, { id, ...observation, ruleIds: [rule.id] });
        accepted = true;
      }
      // Diagnostics count unsupported numeric-looking sentence candidates, not
      // exhaustively parsed measurements or factual errors in source reporting.
      if (!accepted && /同比|环比|[%％]|百分点|百分之/u.test(sentence.text)) rejected.push({ reasonCode: rejectionReason(sentence, ambiguousFragment), scope: span(text, sentence.start, sentence.end) });
    }
    const records = [...observations.values()].sort((a, b) => compare(a.id, b.id));
    for (const record of records) record.ruleIds = [...new Set(record.ruleIds)].sort(compare);
    const numericObservationAssessment = {
      status: records.length ? "applicable" : "undetermined",
      reasonCode: records.length ? "supported_description" : rejected.some((item) => item.reasonCode === "ambiguous_scope") ? "ambiguous_scope" : rejected.length ? "excluded_context" : "no_supported_template",
      observations: records,
    };
    const issues = [...validateReportingFormAssessment(reportingFormAssessment, config.reportingForm), ...validateNumericObservationAssessment(numericObservationAssessment)];
    assert(issues.length === 0, "reportDescription", issues.map((item) => item.message).join("; "));
    return {
      assessment: { reportingFormAssessment, numericObservationAssessment },
      diagnostics: { partialCoverage: records.length > 0 && rejected.length > 0, rejectedCandidateCount: rejected.length, supportedObservationCount: records.length, rejected },
    };
  }
  const assess = (raw, context) => evaluate(raw, context).assessment;
  const diagnose = (raw, context) => evaluate(raw, context).diagnostics;
  return {
    version: REPORT_DESCRIPTION_EXTRACTION_VERSION, normalizationVersion: REPORT_DESCRIPTION_NORMALIZATION_VERSION,
    assess, diagnose,
    validate(result, raw, context) {
      try {
        return isDeepStrictEqual(result, assess(raw, context)) ? [] : [{ level: "error", path: "reportDescription", message: "Description differs from exact own-fragment rule, review, identity and evidence replay" }];
      } catch (cause) { return [{ level: "error", path: "reportDescription", message: cause.message }]; }
    },
  };
}
