import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { applyIdentityResolution } from "../app/lib/identity-projection.mjs";
import { createExplorerPresentation, expandExplorerPresentation } from "../app/lib/explorer-presentation.mjs";
import { createEventSearchDocument, createEntitySearchDocument, matchesSearchDocument, parseSearchQuery, rankEventSearchDocument } from "../app/lib/search.mjs";
import { eventMatchesAction } from "../app/lib/action-assessment.mjs";
import { eventMatchesReportingForm, eventMatchesNumericObservation } from "../app/lib/report-description-assessment.mjs";
import { createGraphIndex, startExploration, expandEntity } from "../app/lib/graph-exploration.mjs";

const [raw, ontology] = await Promise.all(["../data/generated/kg.json", "../data/ontology.json"].map(async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"))));
const full = applyIdentityResolution(raw);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const originalHash = hash(raw);
const transport = createExplorerPresentation(raw, "home");
const home = expandExplorerPresentation(JSON.parse(JSON.stringify(transport)));
const graphTransport = createExplorerPresentation(full, "graph");
const graph = expandExplorerPresentation(JSON.parse(JSON.stringify(graphTransport)));

function documents(kg) {
  const entities = new Map(kg.entities.map((row) => [row.id, row]));
  const sources = new Map(kg.sources.map((row) => [row.id, row]));
  const eventTypes = new Map(ontology.eventTypes.map((row) => [row.id, row]));
  const entityTypes = new Map(ontology.entityTypes.map((row) => [row.id, row]));
  return kg.events.map((event) => {
    const rows = event.entityIds.map((id) => entities.get(id));
    return createEventSearchDocument({ event, entities: rows, source: sources.get(event.sourceIds[0]), eventType: eventTypes.get(event.type), entityTypes: rows.map((row) => entityTypes.get(row.type)) });
  });
}
const fullDocuments = documents(full);
const homeDocuments = documents(home);

test("home and graph presentation stay below the initial JSON budget without mutating accepted data", (context) => {
  for (const [mode, value] of [["home", transport], ["graph", graphTransport]]) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    assert.ok(bytes < 6_000_000, `${mode} presentation is ${bytes} bytes`);
    context.diagnostic(`${mode}: ${bytes.toLocaleString("en-US")} bytes; raw projection: ${Buffer.byteLength(JSON.stringify(full)).toLocaleString("en-US")} bytes`);
  }
  assert.equal(hash(raw), originalHash);
  assert.equal(home.presentationOnly, true);
  assert.equal(graph.presentationOnly, true);
  assert.throws(() => createExplorerPresentation(raw, "semantic"), /Unknown explorer/u);
});

test("every title, summary, entity, topic witness and search metadata survives the wire round-trip", () => {
  assert.equal(home.events.length, full.events.length);
  for (let i = 0; i < full.events.length; i++) {
    for (const field of ["id", "newsId", "title", "date", "datePrecision", "type", "summary", "entityIds", "sourceIds", "significance", "topicEvidence", "identityAssignments"]) assert.deepEqual(home.events[i][field], full.events[i][field], `${full.events[i].newsId}.${field}`);
    assert.deepEqual(homeDocuments[i].fields, fullDocuments[i].fields, full.events[i].newsId);
  }
  assert.deepEqual(home.entities, full.entities);
  for (let i = 0; i < full.sources.length; i++) for (const field of ["id", "title", "kind", "repositoryPath", "archiveUrl", "publishedAt", "episode"]) assert.deepEqual(home.sources[i][field], full.sources[i][field]);
  for (let i = 0; i < full.entities.length; i++) assert.deepEqual(createEntitySearchDocument(home.entities[i], null), createEntitySearchDocument(full.entities[i], null));
});

test("keyword recall and relevance/date ordering are identical to the accepted projection", () => {
  const ordered = (rows, query) => rows.filter((row) => matchesSearchDocument(row, parseSearchQuery(query)))
    .sort((a, b) => rankEventSearchDocument(b, query) - rankEventSearchDocument(a, query) || b.event.date.localeCompare(a.event.date) || a.event.title.localeCompare(b.event.title, "zh-CN"))
    .map((row) => row.event.newsId);
  for (const query of ["GPT4", "C919", "AI", "COVID-19", "北京市", "政策与治理", "医疗健康", "武汉 住房", "财政 税收"]) assert.deepEqual(ordered(homeDocuments, query), ordered(fullDocuments, query), query);
});

test("home action/reporting/numeric facets preserve status and same-assignment conjunctions", () => {
  const ids = (kg, matches) => kg.events.filter(matches).map((row) => row.newsId);
  const actionFilters = [{}, ...["applicable", "not_applicable", "undetermined"].map((status) => ({ status })), ...ontology.hierarchies.action.nodes.filter((node) => node.status === "active").map((node) => ({ conceptId: node.id }))];
  const assignments = new Map(full.events.flatMap((event) => (event.actionAssessment?.assignments ?? []).map((assignment) => [JSON.stringify([assignment.conceptId, assignment.polarity, assignment.modality]), assignment])));
  for (const assignment of assignments.values()) actionFilters.push({ status: "applicable", conceptId: assignment.conceptId, polarity: assignment.polarity, modality: assignment.modality });
  for (const filter of actionFilters) assert.deepEqual(ids(home, (event) => eventMatchesAction(ontology, event, filter)), ids(full, (event) => eventMatchesAction(ontology, event, filter)), JSON.stringify(filter));
  for (const status of ["", "applicable", "undetermined", "not_applicable"]) for (const conceptId of ["", ...(ontology.reportingForm?.concepts ?? []).filter((row) => row.status === "active").map((row) => row.id)]) {
    const filter = { status, conceptId };
    assert.deepEqual(ids(home, (event) => eventMatchesReportingForm(event, filter)), ids(full, (event) => eventMatchesReportingForm(event, filter)));
  }
  for (const status of ["", "applicable", "undetermined"]) for (const comparison of ["", "year_over_year", "month_over_month"]) {
    const filter = { status, comparison };
    assert.deepEqual(ids(home, (event) => eventMatchesNumericObservation(event, filter)), ids(full, (event) => eventMatchesNumericObservation(event, filter)));
  }
  assert.ok(home.events.every((event) => !event.actionAssessment || !("review" in event.actionAssessment)));
  assert.ok(home.events.every((event) => (event.actionAssessment?.assignments ?? []).every((assignment) => !("evidence" in assignment))));
  assert.ok(graph.events.every((event) => !("actionAssessment" in event) && !("reportingFormAssessment" in event) && !("numericObservationAssessment" in event)));
});

test("graph expansions retain the same nodes, chronology endpoints and positions", () => {
  assert.deepEqual(graph.eventRelations.map((row) => [row.from, row.to]), full.eventRelations.map((row) => [row.from, row.to]));
  const complete = createGraphIndex(full); const compact = createGraphIndex(graph);
  const entityId = [...complete.byEntity].sort((a, b) => b[1].length - a[1].length)[0][0];
  const before = startExploration(complete, entityId); const after = startExploration(compact, entityId);
  assert.deepEqual(after, before);
  const nextId = before.nodes.find((node) => node.kind === "entity" && node.id !== entityId)?.id;
  if (nextId) assert.deepEqual(expandEntity(after, compact, nextId), expandEntity(before, complete, nextId));
});

test("historical missing assessments and raw identity labels are retained without invented evidence", () => {
  const first = full.events[0];
  const events = [
    { ...first, id: "event-synthetic-old", newsId: "news-synthetic-old", actionAssessment: undefined, reportingFormAssessment: undefined, numericObservationAssessment: undefined },
    { ...first, id: "event-synthetic-reviewed", newsId: "news-synthetic-reviewed", identityAssignments: [{ assignmentId: "test", rawEntityId: first.entityIds[0], rawLabel: "原始专属名称", identityId: first.entityIds[0] }],
      actionAssessment: { status: "applicable", reasonCode: "supported_description", assignments: [{ conceptId: "action-legal", polarity: "negated", modality: "planned", evidence: [{ scope: { text: "合成证据" } }] }], review: null },
      reportingFormAssessment: { status: "applicable", reasonCode: "reviewed_description", assignments: [{ conceptId: "reporting-form-interview", evidence: [{ text: "访谈" }] }], review: { reason: "审查详情不传到列表" } },
      numericObservationAssessment: { status: "applicable", reasonCode: "supported_description", observations: [{ comparison: "year_over_year", evidence: { scope: { text: "合成同比证据" } } }] } },
  ];
  const fixture = { ...full, events, eventRelations: [] };
  const view = expandExplorerPresentation(createExplorerPresentation(fixture, "home"));
  assert.equal(view.events[0].actionAssessment, undefined);
  assert.equal(view.events[0].reportingFormAssessment, undefined);
  assert.equal(view.events[0].numericObservationAssessment, undefined);
  assert.equal(eventMatchesAction(ontology, view.events[1], { conceptId: "action-legal", polarity: "negated", modality: "planned" }), true);
  assert.equal(eventMatchesAction(ontology, view.events[1], { conceptId: "action-legal", polarity: "affirmative", modality: "planned" }), false);
  assert.equal(eventMatchesReportingForm(view.events[1], { status: "applicable", conceptId: "reporting-form-interview" }), true);
  assert.equal(eventMatchesNumericObservation(view.events[1], { status: "applicable", comparison: "year_over_year" }), true);
  assert.deepEqual(view.events[1].identityAssignments, events[1].identityAssignments);
  assert.equal(matchesSearchDocument(documents(view)[1], parseSearchQuery("原始专属名称")), true);
});
