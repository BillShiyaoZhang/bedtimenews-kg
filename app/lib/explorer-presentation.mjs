import { applyIdentityResolution } from "./identity-projection.mjs";

/**
 * Server presentation transport, never an accepted semantic graph.
 * Repeated strings are dictionary encoded to keep the initial page small.
 * Search text and facet assignments are preserved; source-replay evidence,
 * review details and extraction provenance are loaded by the shared reader.
 * Neither this transport nor its expanded UI view may be passed to semantic
 * validators, identity replay, extraction, release promotion or data builders.
 * @param {object} acceptedGraph An accepted raw graph or its identity projection.
 * @param {'home'|'graph'} mode
 */
export function createExplorerPresentation(acceptedGraph, mode = "home") {
  if (mode !== "home" && mode !== "graph") throw new Error("Unknown explorer presentation mode");
  const kg = applyIdentityResolution(acceptedGraph);
  const strings = [];
  const dictionary = new Map();
  const terms = [];
  const termDictionary = new Map();
  const filterTables = { action: [], reporting: [], numeric: [] };
  const filterDictionaries = { action: new Map(), reporting: new Map(), numeric: new Map() };
  const string = (value) => {
    if (value === undefined || value === null) return -1;
    const saved = dictionary.get(value);
    if (saved !== undefined) return saved;
    const index = strings.length; strings.push(value); dictionary.set(value, index);
    return index;
  };
  const list = (values = []) => values.map(string);
  const term = (value) => { const saved = termDictionary.get(value); if (saved !== undefined) return saved; const index = terms.length; terms.push(value); termDictionary.set(value, index); return index; };
  const filter = (kind, value) => {
    if (!value) return -1;
    const key = JSON.stringify(value);
    const saved = filterDictionaries[kind].get(key);
    if (saved !== undefined) return saved;
    const index = filterTables[kind].length; filterTables[kind].push(value); filterDictionaries[kind].set(key, index);
    return index;
  };
  const entityIndices = new Map(kg.entities.map((entity, index) => [entity.id, index]));
  const sourceIndices = new Map(kg.sources.map((source, index) => [source.id, index]));
  const reference = (indices, id) => { const index = indices.get(id); if (index === undefined) throw new Error(`Unresolved explorer presentation reference: ${id}`); return index; };
  // Frequent scalar values get short indices before unique titles/summaries.
  for (const value of ["", "day", "month", "year", ...new Set(kg.events.map((event) => event.type))]) string(value);
  const entities = kg.entities.map((entity) => [string(entity.id), string(entity.type), string(entity.label), list(entity.aliases), string(entity.description), entity.extraction ?? null, entity.identityResolution ?? null]);
  const sources = kg.sources.map((source) => [string(source.id), string(source.title), string(source.archiveUrl), string(source.repositoryPath), string(source.kind), string(source.publishedAt), source.episode ?? null]);
  const events = kg.events.map((event) => [
    string(event.id), string(event.newsId), string(event.title), string(event.date), string(event.datePrecision), string(event.type), string(event.summary), event.entityIds.map((id) => reference(entityIndices, id)), event.sourceIds.map((id) => reference(sourceIndices, id)), string(event.significance),
    (event.topicEvidence ?? []).map((match) => [reference(entityIndices, match.entityId), match.terms.map(term)]),
    ...(mode === "home" ? [
      filter("action", event.actionAssessment ? [string(event.actionAssessment.status), string(event.actionAssessment.reasonCode), event.actionAssessment.assignments.map((row) => [string(row.conceptId), string(row.polarity), string(row.modality)])] : null),
      filter("reporting", event.reportingFormAssessment ? [string(event.reportingFormAssessment.status), string(event.reportingFormAssessment.reasonCode), event.reportingFormAssessment.assignments.map((row) => string(row.conceptId))] : null),
      filter("numeric", event.numericObservationAssessment ? [string(event.numericObservationAssessment.status), string(event.numericObservationAssessment.reasonCode), event.numericObservationAssessment.observations.map((row) => string(row.comparison))] : null),
    ] : []),
    ...(event.identityAssignments ? [event.identityAssignments] : []),
  ]);
  // The graph consumes chronology endpoints only; provenance is in the reader.
  const eventIndices = new Map(kg.events.map((event, index) => [event.id, index]));
  const eventRelations = mode === "graph" ? kg.eventRelations.map((row) => [reference(eventIndices, row.from), reference(eventIndices, row.to)]) : [];
  // Prefix coding is reversible, including punctuation and UTF-16 text. It
  // saves repeated IDs and archive URL prefixes without truncating summaries.
  const ordered = strings.map((value, index) => ({ value, index })).sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
  const remapping = new Map(ordered.map((entry, index) => [entry.index, index]));
  const remap = (index) => index === -1 ? -1 : remapping.get(index);
  let prior = "";
  const text = ordered.map(({ value }) => {
    let common = 0;
    while (common < prior.length && common < value.length && prior[common] === value[common]) common++;
    const row = [common, value.slice(common)]; prior = value;
    return row;
  });
  for (const row of entities) { for (const index of [0, 1, 2, 4]) row[index] = remap(row[index]); row[3] = row[3].map(remap); }
  for (const row of sources) for (const index of [0, 1, 2, 3, 4, 5]) row[index] = remap(row[index]);
  for (const row of events) for (const index of [0, 1, 2, 3, 4, 5, 6, 9]) row[index] = remap(row[index]);
  for (const row of filterTables.action) { row[0] = remap(row[0]); row[1] = remap(row[1]); row[2] = row[2].map((assignment) => assignment.map(remap)); }
  for (const kind of ["reporting", "numeric"]) for (const row of filterTables[kind]) { row[0] = remap(row[0]); row[1] = remap(row[1]); row[2] = row[2].map(remap); }
  const compactList = (values) => values.map((value) => value.toString(36)).join(".");
  const eventRows = events.map((row) => [compactList([row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[9]]), compactList(row[7]), compactList(row[8]), row[10].map((match) => `${match[0].toString(36)}:${compactList(match[1])}`).join(";"), ...row.slice(11)]);
  return {
    presentationOnly: true, formatVersion: 1, mode, text, terms, filterTables, entities, sources, events: eventRows, eventRelations,
    metadata: { schemaVersion: kg.schemaVersion, generatedAt: kg.generatedAt, source: { name: kg.source.name, url: kg.source.url, mode: kg.source.mode },
      ...(kg.identityNavigation ? { identityNavigation: kg.identityNavigation } : {}), ...(kg.identityRegistrations ? { identityRegistrations: kg.identityRegistrations } : {}) },
  };
}

/** Browser expansion of UI presentation data. This deliberately remains a
 * presentation-only view: missing evidence is not "zero", "unknown" or an
 * unreviewed assessment. Full evidence is available only from reader payloads.
 * Plain fixture/full-graph input is returned unchanged for component reuse.
 */
export function expandExplorerPresentation(presentation) {
  if (presentation?.presentationOnly !== true) return presentation;
  if (presentation.formatVersion !== 1 || !["home", "graph"].includes(presentation.mode)) throw new Error("Unsupported explorer presentation format");
  const strings = [];
  let prior = "";
  for (const [common, suffix] of presentation.text) { prior = prior.slice(0, common) + suffix; strings.push(prior); }
  const string = (index) => index === -1 ? undefined : strings[index];
  const list = (indices) => indices.map(string);
  const entityId = (index) => string(presentation.entities[index][0]);
  const sourceId = (index) => string(presentation.sources[index][0]);
  const expandedList = (value) => value ? value.split(".").map((index) => parseInt(index, 36)) : [];
  const events = presentation.events.map((packed) => {
    const scalar = expandedList(packed[0]);
    const topics = packed[3] ? packed[3].split(";").map((match) => { const [id, values] = match.split(":"); return [parseInt(id, 36), expandedList(values)]; }) : [];
    const row = [...scalar.slice(0, 7), expandedList(packed[1]), expandedList(packed[2]), scalar[7], topics, ...packed.slice(4)];
    const home = presentation.mode === "home";
    const action = home && row[11] !== -1 ? presentation.filterTables.action[row[11]] : null;
    const reporting = home && row[12] !== -1 ? presentation.filterTables.reporting[row[12]] : null;
    const numeric = home && row[13] !== -1 ? presentation.filterTables.numeric[row[13]] : null;
    const identities = row[home ? 14 : 11];
    return {
      id: string(row[0]), newsId: string(row[1]), title: string(row[2]), date: string(row[3]), datePrecision: string(row[4]), type: string(row[5]), summary: string(row[6]), entityIds: row[7].map(entityId), sourceIds: row[8].map(sourceId), significance: string(row[9]),
      topicEvidence: row[10].map((match) => ({ entityId: entityId(match[0]), terms: match[1].map((index) => presentation.terms[index]) })),
      ...(action ? { actionAssessment: { status: string(action[0]), reasonCode: string(action[1]), assignments: action[2].map((assignment) => ({ conceptId: string(assignment[0]), polarity: string(assignment[1]), modality: string(assignment[2]) })) } } : {}),
      ...(reporting ? { reportingFormAssessment: { status: string(reporting[0]), reasonCode: string(reporting[1]), assignments: reporting[2].map((concept) => ({ conceptId: string(concept) })) } } : {}),
      ...(numeric ? { numericObservationAssessment: { status: string(numeric[0]), reasonCode: string(numeric[1]), observations: numeric[2].map((comparison) => ({ comparison: string(comparison) })) } } : {}),
      ...(identities ? { identityAssignments: identities } : {}),
    };
  });
  return {
    ...presentation.metadata, presentationOnly: true, events,
    entities: presentation.entities.map((row) => ({ id: string(row[0]), type: string(row[1]), label: string(row[2]), aliases: list(row[3]), description: string(row[4]), ...(row[5] ? { extraction: row[5] } : {}), ...(row[6] ? { identityResolution: row[6] } : {}) })),
    sources: presentation.sources.map((row) => ({ id: string(row[0]), title: string(row[1]), archiveUrl: string(row[2]), repositoryPath: string(row[3]), kind: string(row[4]), publishedAt: string(row[5]), ...(row[6] ? { episode: row[6] } : {}) })),
    eventRelations: presentation.eventRelations.map((row, index) => ({ id: `presentation-relation-${index}`, from: events[row[0]].id, to: events[row[1]].id, type: "precedes" })),
    entityRelations: [],
  };
}
