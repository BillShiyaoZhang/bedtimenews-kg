// Browser-safe structural validation. Only hash-bound source replay establishes
// that a description was actually supported by this news fragment and its rules.
export const REPORT_DESCRIPTION_NORMALIZATION_VERSION = "visible-fragment-v1";
export const REPORTED_NUMERIC_NAMESPACE_VERSION = "reported-numeric-observation-v1";
export const REPORTING_FORM_IDS = ["reporting-form-interview", "reporting-form-commentary", "reporting-form-analysis"];
export const NUMERIC_COMPARISONS = ["year_over_year", "month_over_month"];
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const stableId = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/u.test(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const isReportDescriptionTimestamp = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value.replace(/(?<!\.\d{3})Z$/u, ".000Z");
};
export const isReportDescriptionSpan = (value, normalized = false) => exact(value, normalized ? ["normalizationVersion", "start", "end", "text"] : ["start", "end", "text"]) && (!normalized || value.normalizationVersion === REPORT_DESCRIPTION_NORMALIZATION_VERSION) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.end > value.start && nonempty(value.text) && value.text.length === value.end - value.start;
export function canonicalReportedDecimal(raw) {
  if (typeof raw !== "string" || !/^[0-9]{1,32}(?:\.[0-9]{1,32})?$/u.test(raw)) throw new Error("Reported decimal must be a bounded unsigned scalar decimal");
  const [integer, fraction = ""] = raw.split(".");
  const whole = integer.replace(/^0+(?=\d)/u, "");
  const tail = fraction.replace(/0+$/u, "");
  const result = tail ? `${whole}.${tail}` : whole;
  if (result === "0") throw new Error("Reported decimal magnitude must be nonzero");
  return result;
}
function collector(path) {
  const issues = [];
  return { issues, error: (suffix, message) => issues.push({ level: "error", path: suffix ? `${path}.${suffix}` : path, message }) };
}
function checkEvidenceList(evidence, error, path) {
  if (!Array.isArray(evidence) || !evidence.length) { error(path, "An explicit decision requires nonempty visible-fragment evidence"); return; }
  const seen = new Set();
  for (const [index, item] of evidence.entries()) {
    if (!isReportDescriptionSpan(item, true)) error(`${path}.${index}`, "Evidence must be an exact normalized UTF-16 span");
    const key = JSON.stringify(item);
    if (seen.has(key)) error(`${path}.${index}`, "Duplicate evidence span");
    seen.add(key);
  }
}
/** @returns {Array<{level: "error", path: string, message: string}>} */
export function validateReportingFormAssessment(assessment, reportingForm, path = "reportingFormAssessment") {
  const { issues, error } = collector(path);
  if (!exact(assessment, ["status", "reasonCode", "assignments", "review"])) { error("", "Reporting-form assessment has missing or unknown fields"); return issues; }
  if (!["applicable", "undetermined", "not_applicable"].includes(assessment.status)) error("status", "Unknown reporting-form status");
  if (!Array.isArray(assessment.assignments)) { error("assignments", "Assignments must be an array"); return issues; }
  const expectedReason = assessment.status === "applicable" ? "reviewed_description" : assessment.status === "not_applicable" ? "reviewed_not_applicable" : assessment.review === null ? "no_review" : "reviewed_undetermined";
  if (assessment.reasonCode !== expectedReason) error("reasonCode", "Reason must agree with the explicit review and assessment status");
  if (assessment.status === "applicable" ? !assessment.assignments.length || assessment.review === null : assessment.assignments.length) error("assignments", "Only explicitly reviewed applicable forms can have assignments");
  if (assessment.status !== "undetermined" && assessment.review === null) error("review", "This status requires an explicit review");
  if (assessment.review !== null) {
    const review = assessment.review;
    if (!exact(review, ["id", "newsId", "fragmentHash", "reviewedAt", "reason", "evidence"])) error("review", "Review has missing or unknown fields");
    else {
      if (!stableId(review.id)) error("review.id", "Review ID must be stable");
      if (!/^news-[a-f0-9]{12}$/u.test(review.newsId ?? "")) error("review.newsId", "Review must bind one exact news ID");
      if (!/^[a-f0-9]{64}$/u.test(review.fragmentHash ?? "")) error("review.fragmentHash", "Review must bind the exact SHA-256 input hash");
      if (!isReportDescriptionTimestamp(review.reviewedAt)) error("review.reviewedAt", "Review requires a valid explicit UTC timestamp");
      if (!nonempty(review.reason)) error("review.reason", "Review requires a reason");
      checkEvidenceList(review.evidence, error, "review.evidence");
    }
  }
  const concepts = new Map((Array.isArray(reportingForm?.concepts) ? reportingForm.concepts : []).filter(object).map((item) => [item.id, item]));
  const seen = new Set();
  for (const [index, assignment] of assessment.assignments.entries()) {
    const at = `assignments.${index}`;
    if (!exact(assignment, ["conceptId", "evidence"])) { error(at, "Assignment has missing or unknown fields"); continue; }
    if (!REPORTING_FORM_IDS.includes(assignment.conceptId) || concepts.get(assignment.conceptId)?.status !== "active") error(`${at}.conceptId`, "Assignment requires an active reporting-form concept");
    if (seen.has(assignment.conceptId)) error(`${at}.conceptId`, "Duplicate reporting-form assignment");
    seen.add(assignment.conceptId);
    checkEvidenceList(assignment.evidence, error, `${at}.evidence`);
  }
  return issues;
}
/** @returns {Array<{level: "error", path: string, message: string}>} */
export function validateNumericObservationAssessment(assessment, path = "numericObservationAssessment") {
  const { issues, error } = collector(path);
  if (!exact(assessment, ["status", "reasonCode", "observations"])) { error("", "Numeric assessment has missing or unknown fields"); return issues; }
  if (!["applicable", "undetermined"].includes(assessment.status)) error("status", "Unsupported numeric status");
  if (!Array.isArray(assessment.observations)) { error("observations", "Observations must be an array"); return issues; }
  if (assessment.status === "applicable" ? !assessment.observations.length || assessment.reasonCode !== "supported_description" : assessment.observations.length || !["no_supported_template", "ambiguous_scope", "excluded_context"].includes(assessment.reasonCode)) error("", "Numeric status, reason and observations disagree");
  const ids = new Set();
  for (const [index, observation] of assessment.observations.entries()) {
    const at = `observations.${index}`;
    if (!exact(observation, ["id", "metric", "value", "comparison", "referencePeriod", "populationOrPlace", "polarity", "modality", "evidence", "ruleIds"])) { error(at, "Numeric observation has missing or unknown fields"); continue; }
    if (!/^reported-numeric-observation-[a-f0-9]{64}$/u.test(observation.id ?? "") || ids.has(observation.id)) error(`${at}.id`, "Numeric observation ID must be unique and revision-scoped");
    ids.add(observation.id);
    if (!NUMERIC_COMPARISONS.includes(observation.comparison)) error(`${at}.comparison`, "Unsupported comparison");
    if (observation.polarity !== "affirmative" || observation.modality !== "reported" || observation.populationOrPlace !== null) error(at, "This grammar supports only affirmative reported descriptions without inferred population/place");
    if (!Array.isArray(observation.ruleIds) || !observation.ruleIds.length || observation.ruleIds.some((id) => !stableId(id)) || new Set(observation.ruleIds).size !== observation.ruleIds.length || JSON.stringify([...observation.ruleIds].sort(compare)) !== JSON.stringify(observation.ruleIds)) error(`${at}.ruleIds`, "Rule supports must be nonempty, unique and code-point sorted");
    const value = observation.value;
    if (!exact(value, ["raw", "decimal", "unit", "measureKind", "direction"])) error(`${at}.value`, "Value has missing or unknown fields");
    else {
      try { if (canonicalReportedDecimal(value.raw) !== value.decimal) error(`${at}.value.decimal`, "Decimal differs from its exact raw magnitude"); } catch (cause) { error(`${at}.value.raw`, cause.message); }
      if (value.unit !== "percent" || value.measureKind !== "relative_change" || !["increase", "decrease"].includes(value.direction)) error(`${at}.value`, "Unsupported measurement semantics");
    }
    const evidence = observation.evidence;
    if (!exact(evidence, ["normalizationVersion", "scope", "metric", "comparison", "direction", "value", "unit", "referencePeriod"]) || evidence.normalizationVersion !== REPORT_DESCRIPTION_NORMALIZATION_VERSION) { error(`${at}.evidence`, "Evidence has missing or unknown fields or normalization"); continue; }
    const validScope = isReportDescriptionSpan(evidence.scope);
    if (!validScope) error(`${at}.evidence.scope`, "Scope must be an exact UTF-16 span");
    for (const key of ["metric", "comparison", "direction", "value", "unit", "referencePeriod"]) {
      const span = evidence[key];
      if (key === "referencePeriod" && span === null) continue;
      if (!isReportDescriptionSpan(span)) { error(`${at}.evidence.${key}`, "Evidence must be an exact UTF-16 span"); continue; }
      if (validScope && (span.start < evidence.scope.start || span.end > evidence.scope.end || evidence.scope.text.slice(span.start - evidence.scope.start, span.end - evidence.scope.start) !== span.text)) error(`${at}.evidence.${key}`, "Evidence must fit the exact local scope");
    }
    const literal = (record, span, key, nullable = false) => {
      if (nullable && record === null && span === null) return;
      if (!exact(record, ["text", "span"]) || !isReportDescriptionSpan(record.span) || record.text !== record.span.text || JSON.stringify(record.span) !== JSON.stringify(span)) error(`${at}.${key}`, "Literal must agree with its exact evidence span");
    };
    literal(observation.metric, evidence.metric, "metric");
    literal(observation.referencePeriod, evidence.referencePeriod, "referencePeriod", true);
    if (value?.raw !== evidence.value?.text) error(`${at}.value.raw`, "Raw decimal must be its exact scalar witness");
    if (evidence.unit && !["%", "％"].includes(evidence.unit.text)) error(`${at}.evidence.unit`, "Unit witness must be a percent sign");
    if (evidence.comparison?.text !== (observation.comparison === "year_over_year" ? "同比" : "环比")) error(`${at}.evidence.comparison`, "Comparison witness disagrees with comparison");
    if (evidence.direction?.text !== (value?.direction === "increase" ? "增长" : "下降")) error(`${at}.evidence.direction`, "Direction witness disagrees with magnitude direction");
    const order = [evidence.referencePeriod, evidence.metric, evidence.comparison, evidence.direction, evidence.value, evidence.unit].filter(Boolean);
    if (order.some((span, position) => position > 0 && span.start < order[position - 1].end)) error(`${at}.evidence`, "Witnesses must follow the supported standalone sentence grammar");
  }
  return issues;
}
function checkedFilter(filter, keys, enums) {
  if (!object(filter) || Object.keys(filter).some((key) => !keys.includes(key)) || Object.values(filter).some((value) => value !== undefined && typeof value !== "string")) throw new Error("Unknown report-description filter field or value");
  for (const [key, allowed] of Object.entries(enums)) if (filter[key] && !allowed.includes(filter[key])) throw new Error(`Unsupported report-description filter ${key}`);
}
export function eventMatchesReportingForm(event, filter = {}) {
  checkedFilter(filter, ["status", "conceptId"], { status: ["applicable", "undetermined", "not_applicable"], conceptId: REPORTING_FORM_IDS });
  if (!Object.values(filter).some(Boolean)) return true;
  const assessment = event.reportingFormAssessment;
  if (!assessment || filter.status && assessment.status !== filter.status) return false;
  return !filter.conceptId || assessment.assignments.some((item) => item.conceptId === filter.conceptId);
}
export function eventMatchesNumericObservation(event, filter = {}) {
  checkedFilter(filter, ["status", "comparison"], { status: ["applicable", "undetermined"], comparison: NUMERIC_COMPARISONS });
  if (!Object.values(filter).some(Boolean)) return true;
  const assessment = event.numericObservationAssessment;
  if (!assessment || filter.status && assessment.status !== filter.status) return false;
  return !filter.comparison || assessment.observations.some((item) => item.comparison === filter.comparison);
}
export function reportingFormLabel(reportingForm, conceptId) {
  return reportingForm?.concepts?.find((item) => item.id === conceptId)?.label ?? conceptId;
}

/** @returns {Array<{level: "error", path: string, message: string}>} */
export function validateReportDescriptionStructure(kg, ontology) {
  const { issues, error } = collector("reportDescription");
  const declaredForm = ontology?.reportingForm !== undefined;
  const declaredNumeric = ontology?.numericObservation !== undefined;
  const version = kg?.source?.reportDescriptionVersion;
  const normalization = kg?.source?.reportDescriptionNormalizationVersion;
  const enabled = declaredForm || declaredNumeric || version !== undefined || normalization !== undefined;
  if (declaredForm !== declaredNumeric) error("ontology", "Both independent description-axis contracts must be declared together");
  if (enabled) {
    if (version !== "1.0.0" || normalization !== REPORT_DESCRIPTION_NORMALIZATION_VERSION) error("source", "Unsupported or missing report-description source version");
    const form = ontology?.reportingForm;
    if (!exact(form, ["schemaVersion", "normalizationVersion", "concepts"]) || form.schemaVersion !== 1 || form.normalizationVersion !== REPORT_DESCRIPTION_NORMALIZATION_VERSION || !Array.isArray(form.concepts) || form.concepts.length !== REPORTING_FORM_IDS.length || new Set(form.concepts.map((entry) => entry?.id)).size !== REPORTING_FORM_IDS.length || form.concepts.some((entry) => !exact(entry, ["id", "label", "description", "status"]) || !REPORTING_FORM_IDS.includes(entry.id) || !nonempty(entry.label) || !nonempty(entry.description) || !["active", "draft"].includes(entry.status))) error("ontology.reportingForm", "Unsupported or incomplete reporting-form vocabulary");
    const numeric = ontology?.numericObservation;
    if (!exact(numeric, ["schemaVersion", "normalizationVersion", "namespaceVersion"]) || numeric.schemaVersion !== 1 || numeric.normalizationVersion !== REPORT_DESCRIPTION_NORMALIZATION_VERSION || numeric.namespaceVersion !== REPORTED_NUMERIC_NAMESPACE_VERSION) error("ontology.numericObservation", "Unsupported numeric-description contract");
  }
  if (!Array.isArray(kg?.events)) { error("events", "Descriptions require a news-event array"); return issues; }
  const observationIds = new Set();
  const reviewIds = new Set();
  for (const [index, event] of kg.events.entries()) {
    const at = `events.${index}`;
    if (!object(event)) { error(at, "Descriptions must belong to a news event"); continue; }
    const hasForm = event.reportingFormAssessment !== undefined;
    const hasNumeric = event.numericObservationAssessment !== undefined;
    if (!enabled && (hasForm || hasNumeric)) error(at, "Historical artifacts cannot contain undeclared report descriptions");
    if (hasForm !== hasNumeric || enabled && (!hasForm || !hasNumeric)) error(at, "Every new-version news event must record both description axes");
    if (hasForm) {
      issues.push(...validateReportingFormAssessment(event.reportingFormAssessment, ontology?.reportingForm, `${at}.reportingFormAssessment`));
      const review = event.reportingFormAssessment?.review;
      if (review) {
        if (review.newsId !== event.newsId) error(`${at}.reportingFormAssessment.review.newsId`, "Review belongs to a different news event");
        if (reviewIds.has(review.id)) error(`${at}.reportingFormAssessment.review.id`, "Review cannot be borrowed by another event");
        reviewIds.add(review.id);
      }
    }
    if (hasNumeric) {
      issues.push(...validateNumericObservationAssessment(event.numericObservationAssessment, `${at}.numericObservationAssessment`));
      const observations = event.numericObservationAssessment?.observations;
      if (Array.isArray(observations)) for (const observation of observations) {
        if (observationIds.has(observation?.id)) error(`${at}.numericObservationAssessment.observations`, "Duplicate or conflicting numeric observation identity across news events");
        observationIds.add(observation?.id);
      }
    }
  }
  return issues;
}
