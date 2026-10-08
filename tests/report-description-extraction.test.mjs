import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { readNewsFragment } from "../scripts/lib/news.mjs";
import {
  assertReportDescriptionConfig, assertReportingFormReviews, assertNumericExtractionConfig,
  createReportDescriptionEngine, reportedNumericObservationId, REPORT_DESCRIPTION_MAX_FRAGMENT_LENGTH, REPORT_DESCRIPTION_AMBIGUITY_CUES,
} from "../scripts/lib/report-description-extraction.mjs";
import { normalizeActionFragment } from "../scripts/lib/action-extraction.mjs";
import {
  canonicalReportedDecimal, validateReportingFormAssessment, validateNumericObservationAssessment,
  validateReportDescriptionStructure, eventMatchesReportingForm, eventMatchesNumericObservation,
} from "../app/lib/report-description-assessment.mjs";
const normalizationVersion = "visible-fragment-v1";
const digest = (raw) => createHash("sha256").update(raw, "utf8").digest("hex");
const context = (raw, newsId = "news-0123456789ab") => ({ newsId, fragmentHash: digest(raw) });
const config = () => ({
  reportingForm: { schemaVersion: 1, normalizationVersion, concepts: [
    { id: "reporting-form-interview", label: "访谈", description: "经审查的访谈形式", status: "active" },
    { id: "reporting-form-commentary", label: "评论", description: "经审查的评论形式", status: "active" },
    { id: "reporting-form-analysis", label: "分析", description: "经审查的分析形式", status: "active" },
  ] },
  numericObservation: { schemaVersion: 1, normalizationVersion, namespaceVersion: "reported-numeric-observation-v1" },
  reportingFormReviews: [],
  numericExtraction: { version: "1.0.0", normalizationVersion, rules: [{ id: "reported-numeric-change-v1", template: "standalone_relative_percent_change_v1", metricTerms: ["工业增加值", "营业收入", "全国居民消费价格", "越南服装出口额", "我国进出口总值", "民间固投"] }] },
});
const engine = createReportDescriptionEngine(config());
const assess = (raw) => engine.assess(raw, context(raw));
const records = (raw) => assess(raw).numericObservationAssessment.observations;
const evidence = (raw, start = 0, end = raw.length) => ({ normalizationVersion, start, end, text: normalizeActionFragment(raw).slice(start, end) });
function reviewed(raw, status = "applicable") {
  return {
    id: "synthetic-form-review", ...context(raw), status, reviewedAt: "2026-10-07T00:00:00Z", reason: "Explicit synthetic fixture decision", evidence: [evidence(raw)],
    assignments: status === "applicable" ? [{ conceptId: "reporting-form-interview", evidence: [evidence(raw)] }] : [],
  };
}
function assertWitnesses(raw, record) {
  const visible = normalizeActionFragment(raw);
  for (const value of Object.values(record.evidence)) {
    if (value === null || typeof value === "string") continue;
    assert.equal(visible.slice(value.start, value.end), value.text);
    assert.equal(value.text.length, value.end - value.start);
    assert.ok(value.start >= record.evidence.scope.start && value.end <= record.evidence.scope.end);
  }
  assert.deepEqual(validateNumericObservationAssessment({ status: "applicable", reasonCode: "supported_description", observations: [record] }), []);
}

test("reported numeric descriptions accept only exact standalone supported relative percentage sentences", () => {
  for (const [raw, metric, comparison, direction, decimal] of [
    ["工业增加值同比增长5.2%。", "工业增加值", "year_over_year", "increase", "5.2"],
    ["营业收入环比下降3%。", "营业收入", "month_over_month", "decrease", "3"],
    ["营业收入 同比 增长 0005.200 ％.", "营业收入", "year_over_year", "increase", "5.2"],
    ["2026年10月营业收入同比增长5%", "营业收入", "year_over_year", "increase", "5"],
    ["今年工业增加值同比增长0.00000000000000000000000000000001%。", "工业增加值", "year_over_year", "increase", "0.00000000000000000000000000000001"],
  ]) {
    const result = records(raw);
    assert.equal(result.length, 1, raw);
    assert.equal(result[0].metric.text, metric);
    assert.equal(result[0].comparison, comparison);
    assert.equal(result[0].value.direction, direction);
    assert.equal(result[0].value.decimal, decimal);
    assert.equal(result[0].populationOrPlace, null);
    assert.equal(result[0].polarity, "affirmative");
    assert.equal(result[0].modality, "reported");
    assertWitnesses(raw, result[0]);
    assert.deepEqual(engine.validate(assess(raw), raw, context(raw)), []);
  }
});

test("strict grammar rejects remote qualifier, comma, colon, newline and relative-clause suffix borrowing", () => {
  const rejected = [
    "预计，营业收入同比增长5%。", "假如市场回暖，营业收入同比增长5%。", "营业收入同比增长5%的目标尚未实现。", "某人否认：营业收入同比增长5%。",
    "预测如下。营业收入同比增长5%。", "否认如下说法。营业收入同比增长5%。", "预计营业收入同比增长5%。工业增加值同比增长6%。", "预测如下。\n\n营业收入同比增长5%。", "否认如下说法。\n\n营业收入同比增长5%。", "预计如下：\n工业增加值同比增长5%。\n营业收入同比增长6%。", "某人否认：营业收入同比增长5%。工业增加值同比增长6%。", "预计\n营业收入同比增长5%。", "假如市场回暖\r\n营业收入同比增长5%。", "某人否认：\n营业收入同比增长5%。", "公司计划：营业收入同比增长5%；工业增加值同比增长6%。",
    "营业收入预计同比增长5%。", "预计营业收入同比增长5%。", "营业收入同比未增长5%。", "营业收入同比不增长5%。", "营业收入同比增长5%是否属实？", "营业收入同比增长5%？",
    "营业收入同比增长5%的说法被否认。", "营业收入同比增长5%才完成目标。", "营业收入同比增长5%之后才投资。", "工业增加值和营业收入同比增长5%。",
    "工业增加值、营业收入同比增长5%。", "营业收入同比增长5%和6%。", "营业收入同比增长5%，工业增加值同比增长6%。", "营业收入同比增长5%；工业增加值同比增长6%。",
    "“营业收入同比增长5%。”", "据称营业收入同比增长5%。", "报道称：营业收入同比增长5%。", "（营业收入同比增长5%。工业增加值同比增长6%。营业收入同比增长7%。）",
    "他说：“营业收入同比增长5%。工业增加值同比增长6%。营业收入同比增长7%。”", "他说：'营业收入同比增长5%。工业增加值同比增长6%。营业收入同比增长7%。'", "营业收入的同比增长5%目标。", "营业收入同比增长了5%。",
  ];
  for (const raw of rejected) assert.equal(records(raw).length, 0, raw);
});

test("unsupported numeric forms never become positive-magnitude reported records", () => {
  for (const scalar of ["0", "00.000", "-5", "+5", ".5", "5.", "5..2", "5e2", "5E-2", "五", "约5", "近5", "超过5", ">5", "≥5", "5至6", "5-6", "5~6", "5、6", "5,2", "1,000", "5/2", "５", "5.2.3", "1".repeat(33), `0.${"1".repeat(33)}`]) {
    const raw = `营业收入同比增长${scalar}%。`;
    assert.equal(records(raw).length, 0, raw);
  }
  for (const raw of ["营业收入同比增长5个百分点。", "营业收入为5%。", "营业收入增长率5%。", "营业收入同比持平。", "营业收入占总收入5%。", "营业收入同比下降-3%。", "明年营业收入同比增长5%。", "北京营业收入同比增长5%。", "营业收入同比增长5元。", "营业收入同比增长5%%。", "营业收入同比增长5%。。"]) assert.equal(records(raw).length, 0, raw);
});

test("decimal canonicalization never rounds through binary floating point", () => {
  assert.equal(canonicalReportedDecimal("00012345678901234567890123456789.12345678901234567890123456789000"), "12345678901234567890123456789.12345678901234567890123456789");
  for (const raw of ["0", "0.0000", "NaN", "Infinity", "-0.1", "+1", "1e3", ".1", "1.", 1]) assert.throws(() => canonicalReportedDecimal(raw));
  const raw = "营业收入同比增长0005.200%。";
  assert.equal(records(raw)[0].value.raw, "0005.200");
});

test("exact shared normalization masks code, URL, image, headings and hidden metadata", () => {
  for (const raw of [
    "<!-- 营业收入同比增长5%。 -->", "`营业收入同比增长5%。`", "```\n营业收入同比增长5%。\n```", "~~~\n营业收入同比增长5%。\n~~~",
    "# 营业收入同比增长5%。", "营业收入同比增长5%。\n===", "<h1>营业收入同比增长5%。</h1>", "<script>营业收入同比增长5%。</script>", "《营业收入同比增长5%。》",
    "![营业收入同比增长5%。](https://example.test/x)", "https://example.test/营业收入同比增长5%。", "[材料](https://example.test/(营业收入同比增长5%)\"标题\")", "---\ntitle: 营业收入同比增长5%。\n---\n",
  ]) assert.equal(records(raw).length, 0, raw);
  const raw = "😀。\r\n<!--隐藏-->[营业收入](https://example.test/a(b))同比增长5.20%。";
  const [record] = records(raw);
  assert.ok(record);
  assert.equal(record.evidence.metric.start, raw.indexOf("营业收入"));
  assertWitnesses(raw, record);
});

test("occurrence identity is revision/news scoped, repeat-safe, restored exactly and independent of supporting rules", () => {
  const raw = "营业收入同比增长5%。营业收入同比增长5%。营业收入同比下降5%。";
  const first = records(raw);
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map((item) => item.id)).size, 3);
  assert.equal(new Set(first.map((item) => item.evidence.value.start)).size, 3);
  const duplicate = config();
  duplicate.numericExtraction.rules.push({ ...duplicate.numericExtraction.rules[0], id: "aaa-second-support" });
  const supported = createReportDescriptionEngine(duplicate).assess(raw, context(raw)).numericObservationAssessment.observations;
  assert.deepEqual(supported.map((item) => item.id), first.map((item) => item.id));
  for (const item of supported) assert.deepEqual(item.ruleIds, ["aaa-second-support", "reported-numeric-change-v1"]);
  assert.deepEqual(records(raw), first);
  const altered = raw.replace("增长5", "增长6");
  assert.ok(records(altered).every((item) => !first.some((prior) => prior.id === item.id)));
  const other = engine.assess(raw, context(raw, "news-abcdef012345")).numericObservationAssessment.observations;
  assert.ok(other.every((item) => !first.some((prior) => prior.id === item.id)));
  for (const item of supported) assert.equal(reportedNumericObservationId(item, context(raw)), item.id);
});

test("unknown reporting forms are never guessed from words, topics or the absence of a numeric match", () => {
  for (const raw of ["访谈评论分析。", "营业收入同比增长5%。", "", "<!--全部隐藏-->"]) assert.deepEqual(assess(raw).reportingFormAssessment, { status: "undetermined", reasonCode: "no_review", assignments: [], review: null });
  assert.equal(assess("没有数值描述。").numericObservationAssessment.reasonCode, "no_supported_template");
});

test("all reviewed form decisions require exact decision evidence and applicable multi-label evidence", () => {
  const raw = "受访者讨论这一问题。";
  for (const status of ["applicable", "undetermined", "not_applicable"]) {
    const own = config();
    const review = reviewed(raw, status);
    if (status === "applicable") review.assignments.push({ conceptId: "reporting-form-analysis", evidence: [evidence(raw, 0, 3)] });
    own.reportingFormReviews.push(review);
    const result = createReportDescriptionEngine(own).assess(raw, context(raw));
    assert.equal(result.reportingFormAssessment.status, status);
    assert.equal(result.reportingFormAssessment.review.newsId, context(raw).newsId);
    assert.deepEqual(validateReportingFormAssessment(result.reportingFormAssessment, own.reportingForm), []);
    assert.equal(result.reportingFormAssessment.assignments.length, status === "applicable" ? 2 : 0);
    const missing = structuredClone(own);
    missing.reportingFormReviews[0].evidence = [];
    assert.throws(() => createReportDescriptionEngine(missing), /evidence/iu);
  }
});

test("review anchors fail closed on edited news, malformed timestamps and evidence; deleted news stays dormant", () => {
  const raw = "受访者讨论这一问题。";
  const own = config();
  own.reportingFormReviews = [reviewed(raw)];
  const reviewedEngine = createReportDescriptionEngine(own);
  assert.throws(() => reviewedEngine.assess(`${raw}修正。`, context(`${raw}修正。`)), /stale review/u);
  assert.equal(reviewedEngine.assess(raw, context(raw, "news-abcdef012345")).reportingFormAssessment.status, "undetermined");
  assert.deepEqual(reviewedEngine.assess(raw, context(raw)), reviewedEngine.assess(raw, context(raw)));
  const corrupt = structuredClone(own);
  corrupt.reportingFormReviews[0].evidence[0].text = "X".repeat(raw.length);
  assert.throws(() => createReportDescriptionEngine(corrupt).assess(raw, context(raw)), /exact normalized/u);
  for (const timestamp of ["2026-02-30T00:00:00Z", "2026-10-07", "2026-10-07T00:00:00+00:00", "now"]) {
    const bad = structuredClone(own); bad.reportingFormReviews[0].reviewedAt = timestamp;
    assert.throws(() => assertReportingFormReviews(bad.reportingFormReviews), /UTC/u);
  }
});

test("strict configuration rejects unknown fields, cross-axis IDs, drafts and conflicting reviews", () => {
  const edits = [
    (value) => { value.extra = true; },
    (value) => { value.reportingForm.extra = true; },
    (value) => { value.reportingForm.concepts[0].id = "action-legal"; },
    (value) => { value.reportingForm.concepts[0].status = "disabled"; },
    (value) => { value.numericObservation.namespaceVersion = "observations"; },
    (value) => { value.numericExtraction.rules[0].template = "quantitative_change"; },
    (value) => { value.numericExtraction.rules[0].metricTerms = ["预计营业收入"]; },
    (value) => { value.numericExtraction.rules[0].metricTerms = ["营业收入", "营业收入"]; },
    (value) => { value.numericExtraction.rules[0].extra = true; },
    (value) => { value.numericExtraction.rules.push(structuredClone(value.numericExtraction.rules[0])); },
    (value) => { value.reportingFormReviews = [reviewed("访谈。")]; value.reportingFormReviews[0].assignments[0].conceptId = "action-legal"; },
    (value) => { value.reportingFormReviews = [reviewed("访谈。")]; value.reportingForm.concepts[0].status = "draft"; },
    (value) => { value.reportingFormReviews = [reviewed("访谈。"), { ...reviewed("访谈。"), id: "duplicate-review" }]; },
    (value) => { value.reportingFormReviews = [reviewed("访谈。")]; value.reportingFormReviews[0].assignments[0].evidence[0].normalizationVersion = "other"; },
  ];
  for (const edit of edits) { const own = config(); edit(own); assert.throws(() => assertReportDescriptionConfig(own)); }
  assert.doesNotThrow(() => assertNumericExtractionConfig(config().numericExtraction));
  assert.doesNotThrow(() => assertReportingFormReviews([reviewed("访谈。")])) ;
  const own = config(); const snapshot = createReportDescriptionEngine(own); own.numericExtraction.rules[0].metricTerms = [];
  assert.equal(snapshot.assess("营业收入同比增长5%。", context("营业收入同比增长5%。")).numericObservationAssessment.observations.length, 1);
});

test("exact replay rejects modified, missing and extra witnesses even after forged observation rehash", () => {
  const raw = "营业收入同比增长5.20%。";
  const original = assess(raw);
  const edits = [
    (item) => { item.value.raw = "6.20"; item.value.decimal = "6.2"; item.evidence.value.text = "6.20"; },
    (item) => { item.metric.text = "工业增加值"; },
    (item) => { item.comparison = "month_over_month"; },
    (item) => { item.evidence.unit.text = "元"; },
    (item) => { item.evidence.direction.text = "下降"; },
    (item) => { item.evidence.value.start += 1; },
    (item) => { delete item.evidence.metric; },
    (item) => { item.evidence.extra = item.evidence.value; },
    (item) => { item.ruleIds = ["invented-support"]; },
    (item) => { item.ruleId = "invented-scalar-support"; },
  ];
  for (const edit of edits) {
    const tampered = structuredClone(original); const item = tampered.numericObservationAssessment.observations[0]; edit(item);
    if (item.evidence.metric) item.id = reportedNumericObservationId(item, context(raw));
    assert.ok(engine.validate(tampered, raw, context(raw)).length);
  }
  assert.throws(() => engine.assess(raw, { ...context(raw), fragmentHash: "0".repeat(64) }), /does not match/u);
  assert.throws(() => engine.assess(raw, { fragmentHash: digest(raw) }), /exactly/u);
});

test("partial numeric coverage is separate diagnostic output, not an exhaustive claim", () => {
  const raw = "营业收入同比增长5%。工业增加值同比增长6个百分点。";
  const result = assess(raw);
  assert.equal(result.numericObservationAssessment.status, "applicable");
  assert.deepEqual(Object.keys(result.numericObservationAssessment).sort(), ["observations", "reasonCode", "status"]);
  const diagnostic = engine.diagnose(raw, context(raw));
  assert.equal(diagnostic.partialCoverage, true);
  assert.equal(diagnostic.supportedObservationCount, 1);
  assert.equal(diagnostic.rejectedCandidateCount, 1);
  assert.equal(diagnostic.rejected[0].reasonCode, "excluded_context");
  assert.equal(engine.diagnose("营业收入同比增长5%。", context("营业收入同比增长5%。")).partialCoverage, false);
});

test("structural validation distinguishes historical absence, unknown and reviewed scope ownership", () => {
  assert.deepEqual(validateReportDescriptionStructure({ source: {}, events: [{ newsId: "news-0123456789ab" }] }, {}), []);
  const raw = "营业收入同比增长5%。";
  const ontology = config();
  const kg = { source: { reportDescriptionVersion: "1.0.0", reportDescriptionNormalizationVersion: normalizationVersion }, events: [{ newsId: context(raw).newsId, ...assess(raw) }] };
  assert.deepEqual(validateReportDescriptionStructure(kg, ontology), []);
  for (const edit of [
    (value) => { delete value.source.reportDescriptionVersion; },
    (value) => { delete value.events[0].numericObservationAssessment; },
    (value) => { value.events.push(structuredClone(value.events[0])); },
    (value) => { value.events[0].numericObservationAssessment.observations[0].ruleIds.reverse(); value.events[0].numericObservationAssessment.observations[0].ruleIds.push("aaa"); },
  ]) { const invalid = structuredClone(kg); edit(invalid); assert.ok(validateReportDescriptionStructure(invalid, ontology).length); }
  assert.ok(validateReportDescriptionStructure(kg, {}).length);
  const own = config(); own.reportingFormReviews = [reviewed(raw)];
  const other = { ...kg, events: [{ newsId: "news-abcdef012345", ...createReportDescriptionEngine(own).assess(raw, context(raw)) }] };
  assert.ok(validateReportDescriptionStructure(other, ontology).some((issue) => issue.message.includes("different news")));
});

test("independent filters never substitute legacy absence for unknown or combine incompatible observations", () => {
  const raw = "营业收入同比增长5%。";
  const event = assess(raw);
  assert.equal(eventMatchesReportingForm(event, { status: "undetermined" }), true);
  assert.equal(eventMatchesReportingForm({}, { status: "undetermined" }), false);
  assert.equal(eventMatchesNumericObservation({}, { status: "undetermined" }), false);
  assert.equal(eventMatchesNumericObservation(event, { status: "applicable", comparison: "year_over_year" }), true);
  assert.equal(eventMatchesNumericObservation(event, { status: "undetermined", comparison: "year_over_year" }), false);
  assert.equal(eventMatchesNumericObservation(event, { comparison: "month_over_month" }), false);
  assert.throws(() => eventMatchesNumericObservation(event, { unit: "percent" }));
  assert.throws(() => eventMatchesReportingForm(event, { conceptId: "action-legal" }));
});

test("bounded input and rule work fail closed before expensive normalization or matching", () => {
  const long = "a".repeat(REPORT_DESCRIPTION_MAX_FRAGMENT_LENGTH + 1);
  assert.throws(() => engine.assess(long, context(long)), /at most/u);
  const brackets = "[".repeat(257);
  assert.throws(() => engine.assess(brackets, context(brackets)), /bounded link-markup/u);
  const own = config(); own.numericExtraction.rules = Array.from({ length: 33 }, (_, index) => ({ ...own.numericExtraction.rules[0], id: `rule-${index}` }));
  assert.throws(() => createReportDescriptionEngine(own), /32 rules/u);
});

test("bounded explicit period prefixes accept one comma or connective without borrowing arbitrary clauses", () => {
  for (const [raw, period, metric, scalar] of [
    ["6月份，全国居民消费价格环比下降0.2%。", "6月份", "全国居民消费价格", "0.2"],
    ["一季度，越南服装出口额同比下降17.7%。", "一季度", "越南服装出口额", "17.7"],
    ["今年前两个月，我国进出口总值同比下降0.8%。", "今年前两个月", "我国进出口总值", "0.8"],
    ["前7个月的民间固投同比下降1.5%。", "前7个月", "民间固投", "1.5"],
    ["6月份,全国居民消费价格环比下降0.2%。", "6月份", "全国居民消费价格", "0.2"],
  ]) {
    const [record] = records(raw);
    assert.ok(record, raw);
    assert.equal(record.referencePeriod.text, period);
    assert.deepEqual(record.referencePeriod.span, { start: 0, end: period.length, text: period });
    assert.equal(record.metric.text, metric);
    assert.equal(record.value.raw, scalar);
    assert.equal(record.populationOrPlace, null);
    assertWitnesses(raw, record);
  }
  for (const raw of [
    "预计，6月份，全国居民消费价格环比下降0.2%。", "6月份，预计全国居民消费价格环比下降0.2%。", "今年前两个月，我国进出口总值未同比下降0.8%。",
    "前7个月的民间固投同比下降1.5%的目标未实现。", "某人否认：前7个月的民间固投同比下降1.5%。", "如果市场回暖，一季度，越南服装出口额同比下降17.7%。",
    "6月份：全国居民消费价格环比下降0.2%。", "6月份，的全国居民消费价格环比下降0.2%。", "6月份的，全国居民消费价格环比下降0.2%。", "今年前两个月，，我国进出口总值同比下降0.8%。",
    "前7个月\n民间固投同比下降1.5%。", "预测期的民间固投同比下降1.5%。", "公司的营业收入同比增长5%。", "今年前两个月的计划，我国进出口总值同比下降0.8%。",
    "预测如下。\n\n6月份，全国居民消费价格环比下降0.2%。\n\n一季度，越南服装出口额同比下降17.7%。",
    "否认如下说法。\n\n今年前两个月，我国进出口总值同比下降0.8%。",
    "预计营业收入同比增长5%。前7个月的民间固投同比下降1.5%。",
  ]) assert.equal(records(raw).length, 0, raw);
});

test("reviewed corpus contexts document conservative whole-fragment abstention and exact remaining evidence", async () => {
  const dataset = JSON.parse(await readFile(new URL("../data/processed/news.json", import.meta.url), "utf8"));
  const fixtures = [
    ["news-b26b186147b3", "6月份，全国居民消费价格环比下降0.2%。", "6月份", "全国居民消费价格", "0.2", 1],
    ["news-1013f09e4740", "一季度，越南服装出口额同比下降17.7%。", "一季度", "越南服装出口额", "17.7", 0],
    ["news-6c897fdeb90b", "今年前两个月，我国进出口总值同比下降0.8%。", "今年前两个月", "我国进出口总值", "0.8", 0],
    ["news-d8e448c98609", "前7个月的民间固投同比下降1.5%。", "前7个月", "民间固投", "1.5", 0],
  ];
  for (const [newsId, clause, period, metric, scalar, expectedCount] of fixtures) {
    const news = dataset.news.find((item) => item.id === newsId);
    assert.ok(news, `Missing reviewed corpus fixture ${newsId}`);
    const page = dataset.pages.find((item) => item.id === news.pageId);
    const rawPage = await readFile(new URL(`../sources/bedtimenews-archive-contents/${page.repositoryPath}`, import.meta.url), "utf8");
    const raw = readNewsFragment(rawPage, news.fragment);
    assert.equal(digest(raw), news.fragment.contentHash);
    const result = engine.assess(raw, { newsId, fragmentHash: news.fragment.contentHash });
    const observations = result.numericObservationAssessment.observations;
    assert.equal(observations.length, expectedCount, `Conservative whole-fragment outcome in ${newsId}`);
    if (expectedCount) {
      const [record] = observations;
      assert.equal(record.evidence.scope.text, clause);
      assert.equal(record.referencePeriod.text, period);
      assert.equal(record.metric.text, metric);
      assert.equal(record.value.raw, scalar);
      assertWitnesses(raw, record);
    } else {
      // These locally supported sentences are deliberately withheld because a
      // different part of their own full visible fragment contains an unresolved
      // cue. Do not relax the guard to preserve a desired corpus match count.
      assert.equal(result.numericObservationAssessment.status, "undetermined");
      assert.equal(result.numericObservationAssessment.reasonCode, "ambiguous_scope");
    }
    assert.deepEqual(engine.validate(result, raw, { newsId, fragmentHash: news.fragment.contentHash }), []);
    // Qualify the complete actual occurrence in its original news context; a
    // standalone suffix must not survive that newly introduced operator.
    for (const replacement of [`预计，${clause}`, `某人否认：${clause}`, `预测如下。\n\n${clause}`]) {
      const altered = raw.replace(clause, replacement);
      assert.notEqual(altered, raw);
      assert.equal(engine.assess(altered, context(altered, newsId)).numericObservationAssessment.observations.length, 0, `${newsId}: ${replacement}`);
    }
  }
});


test("any bounded ambiguity cue excludes the whole visible fragment regardless of order or paragraphs", () => {
  const sentence = "营业收入同比增长5%。";
  for (const cue of REPORT_DESCRIPTION_AMBIGUITY_CUES) {
    for (const raw of [
      `${cue}如下。${sentence}`, `以下是${cue}。\n\n${sentence}`,
      `${cue}。\n\n${sentence}`, `${sentence}\n\n以下说法${cue}。`,
      `${sentence}工业增加值同比增长6%。${cue}。`,
    ]) {
      const assessment = assess(raw).numericObservationAssessment;
      assert.equal(assessment.status, "undetermined", raw);
      assert.equal(assessment.reasonCode, "ambiguous_scope", raw);
      assert.equal(assessment.observations.length, 0, raw);
    }
  }
  for (const raw of ["以下是预测。\n\n营业收入同比增长5%。", "以下说法被否认。\n\n营业收入同比增长5%。", "传闻如下。营业收入同比增长5%。", "预计营业收入同比增长5%。\n\n工业增加值同比增长6%。"]) assert.equal(records(raw).length, 0, raw);
  const raw = "营业收入同比增长5%。预计工业增加值同比增长6%。";
  assert.equal(records(raw).length, 0);
  const diagnostic = engine.diagnose(raw, context(raw));
  assert.equal(diagnostic.supportedObservationCount, 0);
  assert.equal(diagnostic.partialCoverage, false);
  assert.ok(diagnostic.rejected.every((item) => item.reasonCode === "ambiguous_scope"));
  // Cue strings in masked metadata/code/URLs are not visible fragment context.
  for (const raw of [`<!--预测如下-->${sentence}`, `# 以下是预测\n\n${sentence}`, `\`传闻如下\`\n\n${sentence}`, `[材料](https://example.test/传闻预测)。${sentence}`]) assert.equal(records(raw).length, 1, raw);
});
