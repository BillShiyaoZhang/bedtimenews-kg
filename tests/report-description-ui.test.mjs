import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eventMatchesReportingForm, eventMatchesNumericObservation } from "../app/lib/report-description-assessment.mjs";
import { readExplorerLocation, explorerLocationSearch } from "../app/lib/explorer-state.mjs";

const require = createRequire(import.meta.url);
const modules = new Map();
// Content components are rendered with the public reader contract. Navigation,
// memory and browser focus are tested at the provider/browser boundary instead.
const readerContract = `data:text/javascript;base64,${Buffer.from('export function useReader() { return { openNews() {}, openEntity() {}, isRead() { return false; }, isNew() { return false; }, clearReadingHistory() {}, markNewsRead() {}, newCount: 0 }; }').toString("base64")}`;
// Exercise the actual TSX component and URL helpers without a second UI copy or
// source-regex-only assertions. Runtime imports stay local; no fixture is saved
// into production data and these checks do not claim browser/layout coverage.
async function tsModule(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const source = await readFile(url, "utf8");
  if (url.pathname.endsWith(".json")) {
    const result = `data:text/javascript;base64,${Buffer.from(`export default ${JSON.stringify(JSON.parse(source))};`).toString("base64")}`;
    modules.set(url.href, result);
    return result;
  }
  let output = ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const imports = [...output.matchAll(/from\s+["']([^"']+)["']/gu)];
  for (const specifier of new Set(imports.map((match) => match[1]))) {
    let resolved;
    if (specifier.startsWith(".")) {
      const dependency = new URL(specifier, url);
      if (dependency.pathname.endsWith("/reader-provider")) resolved = readerContract;
      else if (/\.mjs$/u.test(dependency.pathname)) resolved = dependency.href;
      else if (/\.json$/u.test(dependency.pathname)) resolved = await tsModule(dependency);
      else {
        const base = dependency.href;
        let extension = ".tsx";
        try { await readFile(new URL(`${base}${extension}`)); } catch { extension = ".ts"; }
        resolved = await tsModule(new URL(`${base}${extension}`));
      }
    } else resolved = pathToFileURL(require.resolve(specifier)).href;
    output = output.replaceAll(`from "${specifier}"`, `from "${resolved}"`).replaceAll(`from '${specifier}'`, `from '${resolved}'`);
  }
  const result = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
  modules.set(url.href, result);
  return result;
}

const { ReportDescriptionDetails } = await import(await tsModule(new URL("../app/components/report-description-details.tsx", import.meta.url)));
const ontology = {
  eventTypes: [{ id: "economy" }],
  hierarchies: { topic: { nodes: [{ id: "topic-economy" }] }, action: { nodes: [{ id: "change-quantitative" }] } },
  reportingForm: { schemaVersion: 1, normalizationVersion: "visible-fragment-v1", concepts: [
    { id: "reporting-form-interview", label: "访谈", description: "合成测试", status: "active" },
    { id: "reporting-form-commentary", label: "评论", description: "合成测试", status: "active" },
    { id: "reporting-form-analysis", label: "分析", description: "合成测试", status: "active" },
  ] },
};
const render = (event, expanded = true) => renderToStaticMarkup(createElement(ReportDescriptionDetails, { ontology, event, expanded }));
const unknown = {
  newsId: "news-synthetic",
  reportingFormAssessment: { status: "undetermined", reasonCode: "no_review", assignments: [], review: null },
  numericObservationAssessment: { status: "undetermined", reasonCode: "no_supported_template", observations: [] },
};
function observation({ direction = "increase", comparison = "year_over_year", period = null, decimal = "5.2", raw = "5.20", prefix = "" } = {}) {
  const metric = "工业增加值";
  const comparisonText = comparison === "year_over_year" ? "同比" : "环比";
  const directionText = direction === "increase" ? "增长" : "下降";
  const clause = `${period ?? ""}${metric}${comparisonText}${directionText}${raw}%。`;
  const span = (text) => ({ start: prefix.length + clause.indexOf(text), end: prefix.length + clause.indexOf(text) + text.length, text });
  const reference = period ? { text: period, span: span(period) } : null;
  return {
    id: `reported-numeric-observation-${direction}-${comparison}-${prefix.length}`,
    metric: { text: metric, span: span(metric) },
    value: { raw, decimal, unit: "percent", measureKind: "relative_change", direction }, comparison,
    referencePeriod: reference, populationOrPlace: null, polarity: "affirmative", modality: "reported",
    evidence: { normalizationVersion: "visible-fragment-v1", scope: { start: prefix.length, end: prefix.length + clause.length, text: clause },
      metric: span(metric), comparison: span(comparisonText), direction: span(directionText), value: span(raw), unit: span("%"), referencePeriod: reference?.span ?? null },
    ruleIds: ["numeric-comparison-percent-v1"],
  };
}
const withNumeric = (...observations) => ({ ...unknown, numericObservationAssessment: { status: "applicable", reasonCode: "supported_description", observations } });

test("historical absence and undetermined descriptions have distinct independent sections", () => {
  const historical = render({ newsId: "old" });
  assert.match(historical, /报道形式（经审查）/u);
  assert.match(historical, /报道中的数值描述/u);
  assert.equal((historical.match(/此版本未记录/gu) ?? []).length, 2);
  assert.doesNotMatch(historical, /尚未确定/u);
  const unreviewed = render(unknown);
  assert.equal((unreviewed.match(/class="report-description-status">尚未确定/gu) ?? []).length, 2);
  assert.doesNotMatch(unreviewed, /此版本未记录/u);
  assert.match(unreviewed, /尚未确定不等于原文没有数值/u);
});

test("numeric descriptions preserve literal metric, decimal precision, raw text, direction and UTF-16 evidence", () => {
  const item = observation({ direction: "decrease", comparison: "month_over_month", decimal: "5.200000000000000001", raw: "5.200000000000000001", prefix: "😀" });
  const html = render(withNumeric(item));
  assert.match(html, /工业增加值/u);
  assert.match(html, /减少 5\.200000000000000001%/u);
  assert.doesNotMatch(html, /-5\.2/u);
  assert.match(html, /环比（与上一期比较）/u);
  assert.match(html, /原文未明确/u);
  assert.ok(html.includes(`原文范围：${item.evidence.scope.text}`));
  assert.ok(html.includes(`UTF-16 [2, ${item.evidence.scope.end})`));
  assert.match(html, /visible-fragment-v1/u);
  assert.match(html, /不代表独立核实/u);
  for (const label of ["指标", "比较", "方向", "数值", "单位"]) assert.ok(html.includes(`${label}：`));
  assert.match(render(withNumeric(observation())), /5\.2%（原文：5\.20%）/u);
});

test("explicit reference periods stay literal and repeated/conflicting occurrences remain separate", () => {
  const one = observation({ period: "今年前三季度" });
  const two = observation({ direction: "decrease", prefix: "前句。" });
  const html = render(withNumeric(one, two));
  assert.match(html, /今年前三季度/u);
  assert.equal((html.match(/class="reported-numeric-observation"/gu) ?? []).length, 2);
  assert.match(html, /增加 5\.2%/u);
  assert.match(html, /减少 5\.2%/u);
  assert.doesNotMatch(html, /平均|合计|汇总|2026年/u);
});

test("reviewed form labels and literal evidence come from the section vocabulary", () => {
  const evidence = { normalizationVersion: "visible-fragment-v1", start: 2, end: 4, text: "访谈" };
  const reviewed = { ...unknown, reportingFormAssessment: { status: "applicable", reasonCode: "reviewed_description",
    assignments: [{ conceptId: "reporting-form-interview", evidence: [evidence] }],
    review: { id: "synthetic-review", newsId: unknown.newsId, fragmentHash: "test-only", reviewedAt: "2026-10-07T00:00:00Z", reason: "合成审查记录", evidence: [evidence] } } };
  const html = render(reviewed);
  assert.match(html, /已有审查标签/u);
  assert.match(html, /<summary>访谈<\/summary>/u);
  assert.match(html, /审查原文：访谈/u);
  assert.match(html, /UTF-16 \[2, 4\)/u);
  assert.match(html, /合成审查记录/u);
});

test("source wording is escaped and detail expansion is explicit", () => {
  const item = observation();
  item.metric.text = "<script>alert(1)</script>";
  assert.doesNotMatch(render(withNumeric(item)), /<script>/u);
  assert.match(render(withNumeric(item)), /&lt;script&gt;/u);
  assert.match(render(withNumeric(item), true), /open=""/u);
  assert.doesNotMatch(render(withNumeric(item), false), /open=""/u);
});

test("new filters use supported records and do not turn historical absence into unknown", () => {
  const event = withNumeric(observation(), observation({ direction: "decrease", comparison: "month_over_month", prefix: "另句。" }));
  assert.equal(eventMatchesNumericObservation(event, { status: "applicable", comparison: "year_over_year" }), true);
  assert.equal(eventMatchesNumericObservation(event, { status: "undetermined", comparison: "month_over_month" }), false);
  assert.equal(eventMatchesNumericObservation(unknown, { status: "undetermined" }), true);
  assert.equal(eventMatchesNumericObservation(unknown, { status: "undetermined", comparison: "year_over_year" }), false);
  assert.equal(eventMatchesNumericObservation({}, { status: "undetermined" }), false);
  assert.equal(eventMatchesReportingForm({}, { status: "undetermined" }), false);
  assert.equal(eventMatchesReportingForm(unknown, { status: "undetermined" }), true);
  assert.equal(eventMatchesReportingForm(unknown, { status: "undetermined", conceptId: "reporting-form-interview" }), false);
  assert.equal(eventMatchesNumericObservation({}, {}), true);
  assert.equal(eventMatchesReportingForm({}, {}), true);
});

test("filter URL snapshots round-trip without state leakage; reset preserves unrelated legacy parameters", () => {
  const original = readExplorerLocation("?entity=old-id&legacy=keep", ontology);
  assert.equal(original.submitted, null);
  const filters = { ...original.filters, reportingFormStatus: "undetermined", numericStatus: "applicable", numericComparison: "year_over_year", fromYear: "2020" };
  const first = explorerLocationSearch("?entity=old-id&legacy=keep", "filters", { mode: "filters", filters });
  assert.ok(first.includes("entity=old-id"));
  assert.ok(first.includes("legacy=keep"));
  assert.deepEqual(readExplorerLocation(first, ontology).submitted, { mode: "filters", filters });
  const second = explorerLocationSearch(first, "filters", { mode: "filters", filters: { ...filters, numericComparison: "month_over_month" } });
  // Back and Forward read the complete URL snapshot; no mutable old selection.
  for (const [url, expected] of [[first, "year_over_year"], [second, "month_over_month"], [first, "year_over_year"], [second, "month_over_month"]]) {
    assert.equal(readExplorerLocation(url, ontology).submitted.filters.numericComparison, expected);
  }
  const reset = explorerLocationSearch(second, "filters", null);
  assert.deepEqual(readExplorerLocation(reset, ontology).filters, original.filters);
  assert.equal(readExplorerLocation(reset, ontology).submitted, null);
  assert.ok(reset.includes("entity=old-id"));
  assert.doesNotMatch(reset, /numeric|reportingForm|fromYear/u);
});

test("unsupported filters are signaled rather than silently broadening old links", () => {
  const invalid = readExplorerLocation("?mode=filters&submitted=1&reportingFormConceptId=action-legal&numericComparison=total&fromYear=20&actionModality=verified", ontology);
  assert.deepEqual(new Set(invalid.invalidFilters), new Set(["reportingFormConceptId", "numericComparison", "fromYear", "actionModality"]));
  assert.equal(invalid.filters.numericComparison, "");
  const clean = explorerLocationSearch("?legacy=keep", "keyword", { mode: "keyword", query: "工业 增加值" });
  assert.deepEqual(readExplorerLocation(clean, ontology).submitted, { mode: "keyword", query: "工业 增加值" });
});

test("news list links and shared reader expose evidence without forcing it into the reading flow", async () => {
  const [{ KGExplorer }, { NewsArticle }, fullOntology] = await Promise.all([
    import(await tsModule(new URL("../app/components/kg-explorer.tsx", import.meta.url))),
    import(await tsModule(new URL("../app/components/news-article.tsx", import.meta.url))),
    readFile(new URL("../data/ontology.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const event = { ...unknown, id: "event-synthetic", title: "合成新闻标题", date: "2026-10-14", datePrecision: "day", type: fullOntology.eventTypes[0].id,
    summary: "一段可点击的新闻摘要", entityIds: [], sourceIds: ["source-synthetic"], significance: "", topicEvidence: [] };
  const source = { id: "source-synthetic", title: "合成档案", repositoryPath: "daily/test.md", repositoryUrl: "https://example.test/source", archiveUrl: "https://example.test/archive", kind: "日报" };
  const kg = { entities: [], sources: [source], events: [event], eventRelations: [], entityRelations: [], source: { url: "https://example.test/archive" } };
  const list = renderToStaticMarkup(createElement(KGExplorer, { initialKG: kg, initialOntology: fullOntology }));
  assert.match(list, /href="\/news\/news-synthetic\/?"[^>]*>合成新闻标题/u);
  assert.match(list, /href="\/news\/news-synthetic\/?"[^>]*>一段可点击的新闻摘要/u);
  assert.match(list, /<details class="card-evidence"><summary>来源与证据/u);
  const evidenceCard = list.slice(list.indexOf('<details class="card-evidence">')).split("</details>")[0];
  assert.match(evidenceCard, /来源：合成档案/u);
  assert.match(evidenceCard, /href="\/news\/news-synthetic\/?"[^>]*>阅读完整来源与证据/u);
  assert.doesNotMatch(evidenceCard, /尚未确定|未记录|0 处证据|UTF-16/u);
  assert.doesNotMatch(list, /autofocus/u);
  const article = renderToStaticMarkup(createElement(NewsArticle, { article: { event, source, entities: [], related: [], markdown: "**合成正文**", contentHash: "test-only", contentStatus: "body", preview: false } }));
  assert.match(article, /<strong>合成正文<\/strong>/u);
  assert.match(article, /<details class="reading-evidence"><summary>来源与证据/u);
  assert.match(article, /报道形式（经审查）/u);
  assert.match(article, /报道中的数值描述/u);
  assert.ok(article.indexOf("合成正文") < article.indexOf("来源与证据"));
});
