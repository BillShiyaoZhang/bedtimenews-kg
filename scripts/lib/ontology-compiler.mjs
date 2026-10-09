import { assertReportDescriptionConfig } from "./report-description-extraction.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hierarchyIndex, sameOntologyCompilation, validateHierarchy } from "../../app/lib/ontology-hierarchy.mjs";
import { assertActionExtractionConfig, assertExtractionRules } from "./extraction-rules.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => createHash("sha256").update(json(value)).digest("hex");
const fail = (message) => { throw new Error(`Ontology compilation failed: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };

// No time, locale ordering, source archive or runtime observations enter compilation.
export function compileOntology(source, patterns) {
  assert(source && typeof source === "object" && !Array.isArray(source), "authored blueprint must be an object");
  assert(Object.keys(source).every((key) => ["formatVersion", "version", "label", "description", "recordUnit", "facets", "eventEntityConstraint", "eventEntityRoles", "relationTypes", "hierarchies", "legacyEntityTypes", "legacyEventDomains", "mappings", "semantics", "actionAssessment", "reportingForm", "numericObservation"].includes(key)), "unknown authored blueprint field");
  assert(patterns && typeof patterns === "object" && !Array.isArray(patterns), "authored extraction patterns must be an object");
  assert(Object.keys(patterns).every((key) => ["version", "description", "topics", "eventClassification", "placeAliases", "organizationSuffixes", "organizationAliases", "facilitySuffixes", "personRoles", "isoRegionCodes", "reviewedNewsEntityLinks", "actionExtraction", "reportingFormReviews", "numericExtraction"].includes(key)), "unknown authored extraction patterns field");
  assert(source.formatVersion === 1, "unknown blueprint formatVersion");
  assert(/^\d+\.\d+\.\d+$/u.test(source.version ?? ""), "version must be explicit semver");
  assert(source.recordUnit?.id === "news" && source.eventEntityConstraint?.minimumEntities === 1, "news projection and minimum entity constraint must be preserved");
  assert(Object.keys(source.hierarchies ?? {}).sort().join(",") === "action,entity,topic", "exactly three known hierarchies are required");
  const hierarchies = {};
  const allIds = new Set();
  for (const kind of ["entity", "action", "topic"]) {
    const hierarchy = source.hierarchies?.[kind];
    const issues = validateHierarchy(hierarchy, kind);
    assert(!issues.length, issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    assert(hierarchy.relation === (kind === "topic" ? "broaderTopic" : "subClassOf"), `${kind} has the wrong hierarchy relation`);
    for (const node of hierarchy.nodes) {
      assert(!allIds.has(node.id), `concept ID reused across hierarchies: ${node.id}`);
      allIds.add(node.id);
    }
    hierarchies[kind] = { ...hierarchy, ...hierarchyIndex(hierarchy) };
  }
  const entityNodes = new Map(hierarchies.entity.nodes.map((node) => [node.id, node]));
  const topicNodes = new Map(hierarchies.topic.nodes.map((node) => [node.id, node]));
  const entityMappings = source.mappings?.entityTypes;
  const topicMappings = source.mappings?.topics;
  function unique(items, key, path) {
    assert(Array.isArray(items) && items.length, `${path} must be a nonempty list`);
    assert(items.every((item) => item && typeof item === "object" && !Array.isArray(item)), `${path} must contain objects`);
    const values = items.map((item) => item[key]);
    assert(values.every((value) => typeof value === "string" && value.trim()) && new Set(values).size === values.length, `${path}.${key} must be nonempty and unique`);
  }
  const assessment = source.actionAssessment;
  const assessmentKeys = ["schemaVersion", "normalizationVersion", "statuses", "polarities", "modalities", "reasonCodes", "templates"];
  assert(assessment && Object.keys(assessment).length === assessmentKeys.length && assessmentKeys.every((key) => Object.hasOwn(assessment, key)), "actionAssessment must contain exactly the supported schema, normalization, vocabulary and template fields");
  assert(assessment.schemaVersion === 1 && assessment.normalizationVersion === "visible-fragment-v1", "unsupported action assessment or normalization version");
  assert(source.semantics?.actionAssignments === "news_scoped_evidence_backed_reported_descriptions" && source.semantics?.actionVerification === "never_verified_real_world_occurrences", "action assignments must be evidence-backed reported descriptions, never verified occurrences");
  assert(source.semantics?.legacyEventTypes === "domain_classification_not_action", "legacy domain semantics must be preserved");
  const vocabularies = {
    statuses: ["applicable", "not_applicable", "undetermined"],
    polarities: ["affirmative", "negated", "undetermined"],
    modalities: ["reported", "planned", "predicted", "conditional", "undetermined"],
    reasonCodes: ["supported_description", "reviewed_not_applicable", "no_supported_rule", "no_visible_body", "ambiguous_scope", "insufficient_context", "excluded_context"],
  };
  for (const [key, ids] of Object.entries(vocabularies)) {
    unique(assessment[key], "id", `actionAssessment.${key}`);
    unique(assessment[key], "label", `actionAssessment.${key}`);
    assert(JSON.stringify(assessment[key].map((entry) => entry.id).sort()) === JSON.stringify([...ids].sort()), `actionAssessment.${key} must define the complete supported vocabulary`);
    for (const entry of assessment[key]) assert(Object.keys(entry).length === 3 && ["id", "label", "description"].every((field) => typeof entry[field] === "string" && entry[field].trim() && entry[field] === entry[field].trim()), `actionAssessment.${key} entries must contain only id, label and description`);
  }
  unique(assessment.templates, "id", "actionAssessment.templates");
  const actionNodes = new Map(hierarchies.action.nodes.map((node) => [node.id, node]));
  const templateIds = ["legal_adjudication", "legal_prosecution", "engineering_lifecycle", "quantitative_change"];
  assert(JSON.stringify(assessment.templates.map((template) => template.id).sort()) === JSON.stringify(templateIds.sort()), "actionAssessment.templates must identify exactly the supported template algorithms");
  for (const template of assessment.templates) {
    const node = actionNodes.get(template.conceptId);
    assert(Object.keys(template).length === 2 && node?.status === "active" && node.abstract === false, `invalid actionAssessment.templates target ${template.conceptId}`);
  }
  assert(patterns.actionExtraction?.normalizationVersion === assessment.normalizationVersion, "action normalization contracts must match");
  assertActionExtractionConfig(patterns.actionExtraction, { hierarchies, actionAssessment: assessment });
  const actionTargets = new Set(patterns.actionExtraction.rules.map((rule) => rule.conceptId));
  for (const node of actionNodes.values()) if (node.status === "active" && !node.abstract) assert(actionTargets.has(node.id), `active action concept has no supported extraction rule: ${node.id}`);
  unique(entityMappings, "legacyId", "mappings.entityTypes");
  unique(topicMappings, "legacyId", "mappings.topics");
  unique(topicMappings, "conceptId", "mappings.topics");
  unique(topicMappings, "entityId", "mappings.topics");
  unique(source.legacyEntityTypes, "id", "legacyEntityTypes");
  const legacyEntityTypes = new Map(source.legacyEntityTypes.map((type) => [type.id, type]));
  assert(legacyEntityTypes.size === entityMappings.length, "legacy entity mappings must be exhaustive");
  const entityTypes = entityMappings.map((mapping) => {
    const { legacyId, conceptId, conceptKind } = mapping;
    const type = legacyEntityTypes.get(legacyId);
    assert(type, `unknown legacy entity type ${legacyId}`);
    if (legacyId === "topic") assert(conceptKind === "TopicConcept" && !conceptId, "legacy topic must map to a controlled concept kind");
    else assert(entityNodes.has(conceptId) && !entityNodes.get(conceptId).abstract && entityNodes.get(conceptId).status === "active" && !conceptKind, `inactive/uninstantiable entity mapping ${legacyId} -> ${conceptId}`);
    assert(/^#[0-9a-f]{6}$/iu.test(type.color ?? ""), `missing color for ${legacyId}`);
    return { ...type, ...(conceptId ? { conceptId } : { conceptKind }) };
  });
  const entityIds = new Set(entityTypes.map((type) => type.id));
  const topicByConcept = new Map(topicMappings.map((mapping) => [mapping.conceptId, mapping]));
  for (const mapping of topicMappings) {
    assert(topicNodes.has(mapping.conceptId) && !topicNodes.get(mapping.conceptId).abstract, `unknown/nonterminal topic mapping ${mapping.conceptId}`);
    assert(/^entity-topic-[a-f0-9]+$/u.test(mapping.entityId), `invalid pinned topic entity ID ${mapping.entityId}`);
  }
  for (const node of topicNodes.values()) if (!node.abstract) assert(topicByConcept.has(node.id), `unmapped topic ${node.id}`);
  unique(source.legacyEventDomains, "id", "legacyEventDomains");
  const eventIds = new Set(source.legacyEventDomains.map((domain) => domain.id));
  assert(eventIds.has("other"), "legacy domains must retain explicit other fallback");
  unique(source.eventEntityRoles, "id", "eventEntityRoles");
  unique(source.facets, "id", "facets");
  unique(source.relationTypes, "id", "relationTypes");
  const membership = new Map();
  for (const role of source.eventEntityRoles) {
    assert(Array.isArray(role.entityTypes) && role.entityTypes.length, `empty role ${role.id}`);
    for (const id of role.entityTypes) { assert(entityIds.has(id), `unknown role entity type ${id}`); membership.set(id, (membership.get(id) ?? 0) + 1); }
  }
  for (const id of entityIds) assert(membership.get(id) === 1, `entity type ${id} must belong to exactly one role`);
  for (const facet of source.facets) {
    for (const id of facet.eventTypes ?? []) assert(id === "*" || eventIds.has(id), `unknown facet event type ${id}`);
    if (facet.entityTypes) assert(JSON.stringify(facet.entityTypes) === JSON.stringify(source.eventEntityRoles.find((role) => role.id === facet.id)?.entityTypes), `facet ${facet.id} differs from its role`);
  }
  for (const relation of source.relationTypes) for (const endpoint of ["from", "to"]) {
    assert(Array.isArray(relation[endpoint]) && relation[endpoint].length, `empty relation ${relation.id}.${endpoint}`);
    for (const id of relation[endpoint]) assert(id === "event" || entityIds.has(id), `unknown relation endpoint ${id}`);
  }
  unique(patterns.topics, "conceptId", "patterns.topics");
  assert(patterns.topics.length === topicMappings.length, "topic rules and mappings must be exhaustive");
  const topicEventTypes = {};
  const topics = patterns.topics.map((rule) => {
    assert(Object.keys(rule).every((key) => ["conceptId", "extractionTriggers", "legacyEventType"].includes(key)), `topic pattern ${rule.conceptId} contains semantic names or unknown fields`);
    const mapping = topicByConcept.get(rule.conceptId);
    assert(mapping, `unknown topic pattern ${rule.conceptId}`);
    assert(topicNodes.get(rule.conceptId).status === "active", `active extraction rule targets inactive topic ${rule.conceptId}`);
    assert(eventIds.has(rule.legacyEventType), `unknown fallback domain ${rule.legacyEventType}`);
    const node = topicNodes.get(rule.conceptId);
    topicEventTypes[mapping.legacyId] = rule.legacyEventType;
    return { id: mapping.legacyId, conceptId: node.id, entityId: mapping.entityId, label: node.label, aliases: node.aliases, extractionTriggers: rule.extractionTriggers };
  });
  unique(patterns.eventClassification, "id", "patterns.eventClassification");
  for (const rule of patterns.eventClassification) {
    assert(Object.keys(rule).length === 2 && Object.hasOwn(rule, "keywords"), `event classification ${rule.id} has unknown fields`);
    assert(Array.isArray(rule.keywords) && rule.keywords.length && rule.keywords.every((keyword) => typeof keyword === "string" && keyword.trim() && keyword === keyword.trim()) && new Set(rule.keywords).size === rule.keywords.length, `event classification ${rule.id} must have unique nonempty keywords`);
    assert(eventIds.has(rule.id), `unknown event classification domain ${rule.id}`);
  }
  const descriptionEnabled = [source.reportingForm, source.numericObservation, patterns.reportingFormReviews, patterns.numericExtraction].some((value) => value !== undefined);
  if (descriptionEnabled) {
    assertReportDescriptionConfig({ reportingForm: source.reportingForm, numericObservation: source.numericObservation, reportingFormReviews: patterns.reportingFormReviews, numericExtraction: patterns.numericExtraction });
    assert(source.semantics?.reportDescriptions === "news_scoped_reported_text_annotations_not_verified_measurements", "report descriptions must remain news-scoped text annotations");
    assert(source.version !== "2.4.0" && patterns.version !== "4.2.0", "report descriptions require explicit ontology and extraction version changes");
    for (const concept of source.reportingForm.concepts) assert(!allIds.has(concept.id), "reporting form IDs must not substitute hierarchy concepts");
  }
  const compilation = { formatVersion: 1, compilerVersion: descriptionEnabled ? "1.2.0" : "1.1.0", sourceHash: digest(source), patternsHash: digest(patterns) };
  const { mappings, legacyEventDomains } = source;
  const metadata = Object.fromEntries(Object.entries(source).filter(([key]) => !["formatVersion", "mappings", "legacyEntityTypes", "legacyEventDomains", "hierarchies"].includes(key)));
  const ontology = { ...metadata, compilation, entityTypes, eventTypes: legacyEventDomains, hierarchies, mappings };
  const rules = { ...patterns, compilation, ontologyVersion: source.version, topics, topicEventTypes };
  if (patterns.reviewedNewsEntityLinks) {
    rules.reviewedNewsEntityLinks = Object.fromEntries(Object.entries(patterns.reviewedNewsEntityLinks).map(([newsId, links]) => {
      assert(Array.isArray(links), `reviewed links for ${newsId} must be an array`);
      return [newsId, links.map((link) => {
        assert(entityIds.has(link.type), `unknown reviewed entity type ${link.type}`);
        if (link.type !== "topic") return link;
        assert(Object.keys(link).every((key) => ["type", "conceptId"].includes(key)), "reviewed topic links must reference conceptId, not redefine names");
        const topic = topics.find((topic) => topic.conceptId === link.conceptId);
        assert(topic, `unknown reviewed topic ${link.conceptId}`);
        return { type: "topic", conceptId: topic.conceptId, label: topic.label, aliases: topic.aliases, entityId: topic.entityId };
      })];
    }));
  }
  assertExtractionRules(rules);
  return { ontology, rules };
}

export async function compileOntologyFiles(root, { write = false } = {}) {
  const read = async (file) => JSON.parse(await readFile(resolve(root, file), "utf8"));
  const [source, patterns] = await Promise.all([read("data/ontology-source.json"), read("data/extraction-patterns.json")]);
  const result = compileOntology(source, patterns);
  for (const [path, value] of [["data/ontology.json", result.ontology], ["data/extraction-rules.json", result.rules]]) {
    if (write) await writeFile(resolve(root, path), json(value), "utf8");
    else assert(await readFile(resolve(root, path), "utf8") === json(value), `${path} is stale or hand-edited; run npm run ontology:compile and explicitly rebuild KG`);
  }
  return result;
}

export function assertAcceptedCompilation(kg, state, compilation) {
  const accepted = [kg.source?.ontologyCompilation, state.ontologyCompilation];
  assert(accepted.every((value) => sameOntologyCompilation(value, compilation)), "accepted ontology/rule fingerprints differ; run npm run kg:rebuild explicitly");
}
