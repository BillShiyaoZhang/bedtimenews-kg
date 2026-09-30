import { createHash } from "node:crypto";
import { canonicalJson } from "./candidate-bundle.mjs";
import { buildKnowledgeGraph } from "./kg-build.mjs";
import { extractExplicitDate } from "./news.mjs";
import { normalizeExtractionText } from "./extraction.mjs";
import { attachIdentityResolution } from "./identity-materialization.mjs";
import { normalizeActionFragment, ACTION_NORMALIZATION_VERSION } from "./action-extraction.mjs";

const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
const identity = (prefix, value) => `${prefix}-${hash(value).slice(0, 24)}`;
const sorted = (values) => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const ensure = (value, message) => { if (!value) throw new Error(`Candidate provenance: ${message}`); };

// Records describe extraction decisions, never the truth of a real-world fact.
// Input text is transient. Persist only normalized hashes, exact witnesses and IDs.
export function buildCandidateProvenance({ kg, dataset, sourceInventory, rawPages, trace, bindings }) {
  const actionEnabled = Boolean(kg.source.actionExtractionVersion);
  const tables = Object.fromEntries(["sourceRevisions", "newsRevisions", "dateDerivations", "inputs", "evidence", "observations", "retention", "classifications", "chronologyGroups", "assertions", "supports", "assertionRevisions", ...(actionEnabled ? ["actionAssessments"] : [])].map((name) => [name, new Map()]));
  function put(table, record) {
    const previous = tables[table].get(record.id);
    ensure(!previous || canonicalJson(previous) === canonicalJson(record), `conflicting identity ${record.id}`);
    tables[table].set(record.id, record);
    return record.id;
  }
  const pageById = new Map(dataset.pages.map((page) => [page.id, page]));
  const newsById = new Map(dataset.news.map((news) => [news.id, news]));
  const events = new Map(kg.events.map((event) => [event.id, event]));
  const entities = new Map(kg.entities.map((entity) => [entity.id, entity]));
  const sourceRevisionByPath = new Map();
  const newsRevisionByEvent = new Map();
  const dateByEvent = new Map();
  const traceByEvent = new Map(trace.news.map((row) => [row.eventId, row]));
  const retentionByKey = new Map(trace.retention.map((row) => [row.candidateKey, row]));
  const retentionByEntity = new Map(trace.retention.map((row) => [row.entityId, row]));
  const directObservationIds = new Map();
  const supportIdsByAssertion = new Map();
  const inputTextById = new Map();
  const inputIds = new Map();
  const inventoryHash = hash(sourceInventory);
  for (const [repositoryPath, contentHash] of Object.entries(sourceInventory).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    ensure(/^[a-f0-9]{64}$/u.test(contentHash), `invalid source hash ${repositoryPath}`);
    const logicalSourceId = identity("source", repositoryPath);
    const id = identity("source-revision", { logicalSourceId, contentHash });
    put("sourceRevisions", { id, logicalSourceId, repositoryPath, contentHash });
    sourceRevisionByPath.set(repositoryPath, id);
  }
  for (const event of kg.events) {
    const news = newsById.get(event.newsId);
    const page = news && pageById.get(news.pageId);
    ensure(news && page, `missing news for ${event.id}`);
    ensure(event.sourceIds.length === 1 && event.sourceIds[0] === page.id, `cross-news source for ${event.id}`);
    ensure(sourceInventory[page.repositoryPath] === page.contentHash && hash(rawPages.get(page.id) ?? "") === page.contentHash, `full source hash mismatch for ${page.repositoryPath}`);
    const sourceRevisionId = sourceRevisionByPath.get(page.repositoryPath);
    const recordHash = hash(news);
    const revision = { newsId: news.id, sourceRevisionId, recordHash };
    const newsRevisionId = put("newsRevisions", { id: identity("news-revision", revision), ...revision });
    newsRevisionByEvent.set(event.id, newsRevisionId);
    let date;
    if (page.publishedAt === "1900-01-01" && news.date !== "1900-01-01") {
      const fragment = normalizeExtractionText(traceByEvent.get(event.id)?.inputs.fragment ?? "");
      const explicit = extractExplicitDate(fragment, { includeWitness: true });
      ensure(explicit?.date === news.date && explicit?.precision === news.datePrecision, `fragment date fallback differs for ${news.id}`);
      date = { kind: "fragment_explicit_date", sourceRevisionId, newsRevisionId, date: news.date, datePrecision: news.datePrecision, evidenceId: witness(event.id, explicit.witness, "fragment"), ruleRef: "extractExplicitDate", pageObservation: page.dateProvenance };
    } else {
      date = { kind: news.date === "1900-01-01" ? "unknown" : page.dateProvenance.resolution === "observed" ? "page_publication_date" : "corpus_reconciled_publication_date", sourceRevisionId, date: news.date, datePrecision: news.datePrecision, provenance: page.dateProvenance, ...(page.dateProvenance.resolution !== "observed" ? { corpusInventoryHash: inventoryHash } : {}) };
    }
    dateByEvent.set(event.id, put("dateDerivations", { id: identity("date", date), ...date }));
  }
  function input(eventId, role) {
    const key = `${eventId}:${role}`;
    if (inputIds.has(key)) return inputIds.get(key);
    const row = traceByEvent.get(eventId);
    ensure(row, `missing extraction trace ${eventId}`);
    const kind = { text: "title_summary_fragment", prominent: "title_summary", primary: "title_summary", context: "title_summary_fragment", fragment: "fragment", search: "cleaned_search_text", action: "visible_action_fragment" }[role];
    ensure(kind, `unknown evidence input ${role}`);
    const raw = row.inputs[{ primary: "prominent", context: "text", action: "fragment" }[role] ?? role];
    ensure(typeof raw === "string", `missing consumed input ${eventId}/${role}`);
    const normalizationId = role === "action" ? ACTION_NORMALIZATION_VERSION : role === "search" ? "clean-text-v1" : "extraction-normalized-v1";
    const normalized = role === "action" ? normalizeActionFragment(raw) : role === "search" ? raw : normalizeExtractionText(raw);
    const record = { newsRevisionId: newsRevisionByEvent.get(eventId), kind, normalizationId, contentHash: hash(normalized), origin: ["fragment", "action"].includes(role) ? "verified_fragment" : ["text", "context", "search"].includes(role) ? "mixed_fragment_and_derived_fields" : "derived_news_fields" };
    const id = put("inputs", { id: identity("input", record), ...record });
    inputTextById.set(id, normalized);
    inputIds.set(key, id);
    return id;
  }
  function witness(eventId, value, role = value.input) {
    const inputId = input(eventId, role);
    const normalized = inputTextById.get(inputId);
    ensure(Number.isInteger(value.start) && Number.isInteger(value.end) && value.start >= 0 && value.end > value.start && value.end <= normalized.length && normalized.slice(value.start, value.end) === value.text, `forged witness ${eventId}/${role}`);
    const record = { inputId, text: value.text };
    const id = identity("evidence", record);
    const previous = tables.evidence.get(id);
    if (!previous) tables.evidence.set(id, { id, ...record, ranges: [[value.start, value.end]] });
    else if (!previous.ranges.some(([start, end]) => start === value.start && end === value.end)) previous.ranges.push([value.start, value.end]);
    return id;
  }
  function assertion(subject, predicate, object) {
    const record = { subject, predicate, object, epistemicScope: "extraction_assignment" };
    return put("assertions", { id: identity("assertion", record), ...record });
  }
  // Action qualifiers belong to an exact occurrence, not the first identical
  // term anywhere in a news item. Legacy topic/entity witnesses remain unchanged.
  function actionWitness(eventId, span) {
    const inputId = input(eventId, "action");
    const normalized = inputTextById.get(inputId);
    ensure(Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= normalized.length && normalized.slice(span.start, span.end) === span.text, `forged action witness ${eventId}`);
    const basis = { inputId, start: span.start, end: span.end, text: span.text };
    return put("evidence", { id: identity("action-evidence", basis), inputId, text: span.text, firstRange: [span.start, span.end], occurrenceCount: 1, spanPolicy: "exact_action_occurrence" });
  }
  function support(assertionId, details) {
    const record = { assertionId, ...details };
    const id = put("supports", { id: identity("support", record), ...record });
    const ids = supportIdsByAssertion.get(assertionId) ?? new Set();
    ids.add(id);
    supportIdsByAssertion.set(assertionId, ids);
  }
  for (const row of trace.news) {
    const event = events.get(row.eventId);
    ensure(event && event.newsId === row.newsId, `unknown or cross-news trace ${row.eventId}`);
    for (const observation of row.observations) {
      const retention = retentionByKey.get(observation.candidateKey);
      ensure(retention, `missing retention ${observation.candidateKey}`);
      const evidenceIds = [...new Set(observation.evidence.map((value) => witness(event.id, value)))].sort();
      ensure(evidenceIds.length || observation.input === "none" && observation.method === "reviewed_news_link", `unsupported observation ${observation.candidateKey}`);
      const record = { newsRevisionId: newsRevisionByEvent.get(event.id), candidateKey: observation.candidateKey, entityId: retention.entityId, method: observation.method, confidence: observation.confidence, prominent: observation.prominent, ruleRef: observation.ruleRef };
      const observationId = identity("observation", record);
      const previous = tables.observations.get(observationId);
      if (!previous) tables.observations.set(observationId, { id: observationId, ...record, evidenceIds });
      else previous.evidenceIds = [...new Set([...previous.evidenceIds, ...evidenceIds])].sort();
      const observed = directObservationIds.get(observation.candidateKey) ?? new Set();
      observed.add(observationId);
      directObservationIds.set(observation.candidateKey, observed);
      if (retention.retained && !previous) {
        ensure(event.entityIds.includes(retention.entityId), `direct support missing from projection ${event.id}/${retention.entityId}`);
        support(assertion(event.id, "assigned_entity", retention.entityId), { method: "direct_extraction", observationId, prerequisiteIds: [identity("retention", retention.entityId)] });
      }
    }
    ensure(row.classification.type === event.type, `classification differs for ${event.id}`);
    const steps = row.classification.steps.map((step) => ({ inputId: input(event.id, step.input), scores: step.scores, winner: step.winner, stage: step.stage, ruleRef: step.ruleRef, evidenceIds: [...new Set(step.evidence.map((value) => witness(event.id, value, step.input)))].sort() }));
    const decision = { eventId: event.id, newsRevisionId: newsRevisionByEvent.get(event.id), type: row.classification.type, selectedInput: row.classification.selectedInput, steps };
    const decisionId = put("classifications", { id: identity("classification", decision), ...decision });
    support(assertion(event.id, "assigned_legacy_domain", event.type), { method: "classification", decisionId });
    ensure(Boolean(row.actionAssessment) === actionEnabled && Boolean(event.actionAssessment) === actionEnabled, `missing or unexpected action assessment ${event.id}`);
    if (actionEnabled) {
      ensure(canonicalJson(row.actionAssessment) === canonicalJson(event.actionAssessment), `action assessment differs for ${event.id}`);
      const assessment = row.actionAssessment;
      const evidenceIds = new Set();
      const exact = (span) => { const id = actionWitness(event.id, span); evidenceIds.add(id); return id; };
      const assignments = assessment.assignments.map((item) => ({ conceptId: item.conceptId, polarity: item.polarity, modality: item.modality,
        evidence: item.evidence.map((match) => ({ ruleId: match.ruleId, predicateEvidenceId: exact(match.predicate), scopeEvidenceId: exact(match.scope), qualifiers: match.qualifiers.map(({ kind, value, ...span }) => ({ kind, value, evidenceId: exact(span) })) })) }));
      const review = assessment.review ? { id: assessment.review.id, reviewedAt: assessment.review.reviewedAt, reason: assessment.review.reason, evidenceId: exact(assessment.review.evidence) } : null;
      const decision = { eventId: event.id, newsRevisionId: newsRevisionByEvent.get(event.id), inputId: input(event.id, "action"), status: assessment.status, reasonCode: assessment.reasonCode, assignments, review, evidenceIds: [...evidenceIds].sort() };
      const actionAssessmentId = put("actionAssessments", { id: identity("action-assessment", decision), ...decision });
      support(assertion(event.id, "action_applicability", assessment.status), { method: "action_assessment", actionAssessmentId });
      for (const item of assignments) for (const match of item.evidence) {
        const object = { conceptId: item.conceptId, polarity: item.polarity, modality: item.modality };
        support(assertion(event.id, "assigned_reported_action", object), { method: "fragment_action_rule", actionAssessmentId, ruleId: match.ruleId,
          evidenceIds: [...new Set([match.predicateEvidenceId, match.scopeEvidenceId, ...match.qualifiers.map((qualifier) => qualifier.evidenceId)])].sort() });
      }
    }
  }
  for (const observation of tables.observations.values()) observation.revisionId = identity("observation-revision", observation);
  for (const row of trace.retention) {
    const observationIds = [...(directObservationIds.get(row.candidateKey) ?? [])].sort();
    ensure(observationIds.length, `retention without direct observations ${row.entityId}`);
    const distinctNewsRevisionIds = [...new Set(observationIds.map((id) => tables.observations.get(id).newsRevisionId))].sort();
    const record = { entityId: row.entityId, candidateKey: row.candidateKey, type: row.type, label: row.label, method: row.method, confidence: row.confidence, prominent: row.prominent, criterion: row.criterion, retained: row.retained, distinctNewsCount: distinctNewsRevisionIds.length, observationIds };
    ensure(distinctNewsRevisionIds.length === row.directEventIds.length, `retention direct news count mismatch ${row.entityId}`);
    put("retention", { id: identity("retention", row.entityId), revisionId: identity("retention-revision", record), ...record });
  }
  for (const row of trace.rescans) {
    const event = events.get(row.eventId);
    const retained = retentionByEntity.get(row.entityId);
    ensure(event?.entityIds.includes(row.entityId) && retained?.retained, `unsupported rescan ${row.eventId}/${row.entityId}`);
    const evidenceIds = [...new Set(row.matches.map((match) => witness(row.eventId, match, "search")))].sort();
    ensure(evidenceIds.length && row.normalizationId === "clean-text-v1", "empty or invalid rescan witness");
    support(assertion(row.eventId, "assigned_entity", row.entityId), { method: "global_name_rescan", newsRevisionId: newsRevisionByEvent.get(row.eventId), evidenceIds, prerequisiteIds: [identity("retention", row.entityId)] });
  }
  const relations = new Map(kg.eventRelations.map((relation) => [relation.id, relation]));
  for (const row of trace.chronology) {
    const relation = relations.get(row.relationId);
    ensure(relation && relation.from === row.from && relation.to === row.to && relation.type === "precedes", `unknown chronology ${row.relationId}`);
    const from = events.get(row.from);
    const to = events.get(row.to);
    ensure(from && to && from.date < to.date && from.entityIds.includes(row.viaEntityId) && to.entityIds.includes(row.viaEntityId), `invalid chronology endpoints ${row.relationId}`);
    const group = { entityId: row.viaEntityId, maximumMentions: row.maximumMentions, mentionedEventIds: [...row.mentionedEventIds].sort() };
    const groupId = put("chronologyGroups", { id: identity("chronology-group", group), ...group });
    const prerequisiteIds = [assertion(from.id, "assigned_entity", row.viaEntityId), assertion(to.id, "assigned_entity", row.viaEntityId)].sort();
    support(assertion(from.id, "news_date_precedes", to.id), { method: "news_date_chronology", relationId: row.relationId, viaEntityId: row.viaEntityId, groupId, newsRevisionIds: [newsRevisionByEvent.get(from.id), newsRevisionByEvent.get(to.id)], dateDerivationIds: [dateByEvent.get(from.id), dateByEvent.get(to.id)], prerequisiteIds });
  }
  for (const row of tables.assertions.values()) {
    const supportIds = [...(supportIdsByAssertion.get(row.id) ?? [])].sort();
    ensure(supportIds.length, `unsupported assignment ${row.id}`);
    const record = { assertionId: row.id, state: "materialized", supportIds };
    put("assertionRevisions", { id: identity("assertion-revision", record), ...record });
  }
  const expectedAssertions = new Set();
  for (const event of kg.events) {
    for (const entityId of event.entityIds) { ensure(entities.has(entityId), `dangling entity ${entityId}`); expectedAssertions.add(assertion(event.id, "assigned_entity", entityId)); }
    expectedAssertions.add(assertion(event.id, "assigned_legacy_domain", event.type));
    if (actionEnabled) {
      expectedAssertions.add(assertion(event.id, "action_applicability", event.actionAssessment.status));
      for (const item of event.actionAssessment.assignments) expectedAssertions.add(assertion(event.id, "assigned_reported_action", { conceptId: item.conceptId, polarity: item.polarity, modality: item.modality }));
    }
  }
  for (const relation of kg.eventRelations) expectedAssertions.add(assertion(relation.from, "news_date_precedes", relation.to));
  ensure(expectedAssertions.size === tables.assertionRevisions.size && expectedAssertions.size === tables.assertions.size && [...expectedAssertions].every((id) => supportIdsByAssertion.has(id)), "projection/support materialization is not bijective");
  for (const entity of kg.entities) ensure(retentionByEntity.get(entity.id)?.retained, `unexplained retained entity ${entity.id}`);
  for (const row of tables.supports.values()) for (const id of row.prerequisiteIds ?? []) ensure(tables.retention.has(id) || supportIdsByAssertion.has(id), `dangling prerequisite ${id}`);
  const contentGroups = new Map();
  for (const row of tables.newsRevisions.values()) {
    const contentHash = newsById.get(row.newsId).fragment.contentHash;
    const ids = contentGroups.get(contentHash) ?? [];
    ids.push(row.id);
    contentGroups.set(contentHash, ids);
  }
  const duplicateContentGroups = [...contentGroups.entries()].filter(([, ids]) => ids.length > 1).map(([contentHash, newsRevisionIds]) => ({ id: identity("duplicate-fragment", contentHash), contentHash, newsRevisionIds: newsRevisionIds.sort(), independence: "not_established" }));
  for (const evidence of tables.evidence.values()) {
    if (evidence.spanPolicy === "exact_action_occurrence") continue;
    evidence.ranges.sort(([a, b], [c, d]) => a - c || b - d);
    evidence.firstRange = evidence.ranges[0];
    evidence.occurrenceCount = evidence.ranges.length;
    delete evidence.ranges;
  }
  return { chronologySemantics: "legacy_selected_news_date_order_including_explicit_fragment_fallback_not_actual_occurrence_order", witnessPolicy: "first_exact_span_per_input_and_surface_with_occurrence_count", ...(actionEnabled ? { actionWitnessPolicy: "exact_occurrence_in_offset_preserving_visible_news_fragment" } : {}), schemaVersion: "1.0.0", epistemicScope: "extraction_assignment", independence: "not_assessed_support_count_is_not_independent_source_count", bindings, sourceInventoryHash: inventoryHash, ...Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, sorted(table.values())])), duplicateContentGroups: sorted(duplicateContentGroups) };
}

// Recompute decisions from verified source input; stored ledger records are not trusted.
export function validateCandidateProvenance(provenance, options) {
  try {
    const { kg, dataset, rawPages, ontology, rules } = options;
    const rebuilt = buildKnowledgeGraph({ dataset, rawPages, ontology, rules, generatedAt: kg.generatedAt, collectTrace: true });
    const expected = buildCandidateProvenance({ ...options, kg: rebuilt.kg, trace: rebuilt.trace });
    const expectedKG = attachIdentityResolution({ kg: rebuilt.kg, news: dataset, provenance: expected, config: options.identityRegistry, baselineOverlay: options.baselineOverlay });
    ensure(hash(expectedKG) === hash(kg), "candidate KG differs from deterministic materialization including identity resolution");
    rebuilt.trace = null;
    ensure(Object.keys(provenance).sort().join(",") === Object.keys(expected).sort().join(","), "stored provenance collections differ");
    for (const key of Object.keys(expected)) ensure(hash(provenance[key]) === hash(expected[key]), `stored provenance ${key} differs from replayed witnesses/supports`);
    return [];
  } catch (error) { return [{ level: "error", path: "provenance", message: error.message }]; }
}
