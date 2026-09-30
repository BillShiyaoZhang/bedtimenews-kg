// Configuration is the only authority for topic names and extraction triggers.
// Fail closed on the old overloaded field instead of silently restoring aliases.
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
}
