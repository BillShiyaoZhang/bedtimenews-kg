import type { KnowledgeBase } from "./kg";

export function mergeKnowledgeBases(
  generated: KnowledgeBase,
  curated: KnowledgeBase,
): KnowledgeBase {
  return {
    ...generated,
    schemaVersion: curated.schemaVersion,
    generatedAt:
      generated.generatedAt > curated.generatedAt
        ? generated.generatedAt
        : curated.generatedAt,
    entities: mergeById(generated.entities, curated.entities),
    events: mergeById(generated.events, curated.events),
    eventRelations: mergeById(
      generated.eventRelations,
      curated.eventRelations,
    ),
    entityRelations: mergeById(
      generated.entityRelations,
      curated.entityRelations,
    ),
    sources: mergeById(generated.sources, curated.sources),
  };
}

function mergeById<T extends { id: string }>(
  generated: T[],
  curated: T[],
): T[] {
  const merged = new Map(generated.map((item) => [item.id, item]));
  for (const item of curated) merged.set(item.id, item);
  return [...merged.values()];
}
