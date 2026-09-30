// Shared browser/Node structural contract. Source-fragment verification is run
// by scripts/lib/topic-evidence.mjs before generated data can be published.
/** @returns {Array<{level: "error", path: string, message: string}>} */
export function validateTopicEvidenceStructure(kg) {
  const issues = [];
  const topics = new Set(kg.entities.filter((entity) => entity.type === "topic").map((entity) => entity.id));
  for (const [index, event] of kg.events.entries()) {
    const path = `events.${index}.topicEvidence`;
    if (!Array.isArray(event.topicEvidence)) {
      issues.push({ level: "error", path, message: "新闻必须声明 topicEvidence 数组（无匹配时为空）" });
      continue;
    }
    const seen = new Set();
    for (const [matchIndex, match] of event.topicEvidence.entries()) {
      if (!match || !topics.has(match.entityId) || !event.entityIds?.includes(match.entityId) || seen.has(match.entityId)) {
        issues.push({ level: "error", path: `${path}.${matchIndex}`, message: "主题证据必须唯一引用本新闻已关联的主题实体" });
      }
      seen.add(match?.entityId);
      if (!Array.isArray(match?.terms) || !match.terms.length || match.terms.some((term) =>
        typeof term !== "string" || !term.trim()) || new Set(match.terms).size !== match.terms.length) {
        issues.push({ level: "error", path: `${path}.${matchIndex}.terms`, message: "主题证据必须包含非空且不重复的实际命中词" });
      }
    }
  }
  return issues;
}
