import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileOntology } from "../scripts/lib/ontology-compiler.mjs";
import { ACCEPTED_SEMANTIC_GENERATOR_FILES } from "../scripts/lib/accepted-transition.mjs";
import { reportDescriptionDiff, summarizeReportDescriptions } from "../scripts/lib/report-description-reporting.mjs";
import { createReportDescriptionEngine } from "../scripts/lib/report-description-extraction.mjs";
import { sha256 } from "../scripts/lib/candidate-bundle.mjs";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const [source, patterns] = await Promise.all([read("ontology-source.json"), read("extraction-patterns.json")]);
const config = { reportingForm: source.reportingForm, numericObservation: source.numericObservation, reportingFormReviews: patterns.reportingFormReviews, numericExtraction: patterns.numericExtraction };

test("report-description compilation fails closed on cross-axis, unknown, stale-version and incomplete contracts", () => {
  assert.deepEqual(compileOntology(source, patterns), compileOntology(structuredClone(source), structuredClone(patterns)));
  for (const alter of [
    (s) => { s.reportingForm.extra = true; },
    (s) => { s.numericObservation.namespaceVersion = "observation"; },
    (s) => { s.reportingForm.concepts[0].id = "action-legal"; },
    (s) => { delete s.numericObservation; },
    (s) => { s.hierarchies.reportingForm = s.hierarchies.action; },
    (s) => { s.version = "2.4.0"; },
    (_s, p) => { p.version = "4.2.0"; },
    (_s, p) => { delete p.reportingFormReviews; },
    (_s, p) => { p.numericExtraction.rules[0].template = "quantitative_change"; },
    (_s, p) => { p.numericExtraction.rules[0].metricTerms.push("销售额"); },
  ]) {
    const s = structuredClone(source), p = structuredClone(patterns); alter(s, p);
    assert.throws(() => compileOntology(s, p));
  }
});

test("legacy authored contracts remain readable and empty review registry asserts no reporting form", () => {
  const s = structuredClone(source), p = structuredClone(patterns);
  delete s.reportingForm; delete s.numericObservation; delete s.semantics.reportDescriptions;
  delete p.reportingFormReviews; delete p.numericExtraction; s.version = "2.4.0"; p.version = "4.2.0";
  const old = compileOntology(s, p);
  assert.equal(old.ontology.compilation.compilerVersion, "1.1.0");
  assert.equal(old.ontology.reportingForm, undefined);
  assert.deepEqual(patterns.reportingFormReviews, []);
  assert.deepEqual(Object.keys(source.hierarchies).sort(), ["action", "entity", "topic"]);
});

test("description diff distinguishes historical absence and reports partial supported-template coverage", () => {
  const newsId = "news-0123456789ab";
  const fragment = "工业增加值同比增长5.20%。营业收入为3%。";
  const engine = createReportDescriptionEngine(config);
  const context = { newsId, fragmentHash: sha256(fragment) };
  const before = { source: {}, events: [{ id: "event-old", newsId }] };
  const after = { source: { reportDescriptionVersion: "1.0.0" }, events: [{ ...before.events[0], ...engine.assess(fragment, context) }] };
  const diff = reportDescriptionDiff(before, after).reportDescriptions;
  assert.equal(diff.before.reportingForm.unrecordedLegacyNews, 1);
  assert.equal(diff.before.numericObservation.unrecordedLegacyNews, 1);
  assert.equal(diff.after.reportingForm.statusCounts.undetermined, 1);
  assert.equal(diff.after.numericObservation.statusCounts.applicable, 1);
  assert.deepEqual(diff.changedNewsIds, [newsId]);
  const diagnostics = engine.diagnose(fragment, context);
  const report = summarizeReportDescriptions(after, { numericObservationAssessments: [{ diagnostics }] });
  assert.equal(report.numericObservation.diagnostics.partialCoverageNews, 1);
  assert.equal(report.numericObservation.diagnostics.rejectedCandidateCount, 1);
  assert.equal(report.numericObservation.diagnostics.supportedObservationCount, 1);
});

test("all report description generator and validator modules are semantic migration dependencies", () => {
  for (const path of ["app/lib/report-description-assessment.mjs", "scripts/lib/report-description-extraction.mjs", "scripts/lib/report-description-evidence.mjs", "scripts/lib/report-description-reporting.mjs"]) assert.ok(ACCEPTED_SEMANTIC_GENERATOR_FILES.includes(path), path);
});
