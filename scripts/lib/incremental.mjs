import { materializeEntity } from "./extraction.mjs";

export function classifyArchiveChanges(acceptedFiles, currentFiles) {
  const addedCandidates = Object.keys(currentFiles)
    .filter((path) => !(path in acceptedFiles))
    .sort();
  const modified = Object.keys(acceptedFiles)
    .filter(
      (path) =>
        path in currentFiles && acceptedFiles[path] !== currentFiles[path],
    )
    .sort()
    .map((path) => ({
      path,
      acceptedHash: acceptedFiles[path],
      currentHash: currentFiles[path],
    }));
  const deleted = Object.keys(acceptedFiles)
    .filter((path) => !(path in currentFiles))
    .sort()
    .map((path) => ({ path, acceptedHash: acceptedFiles[path] }));

  const acceptedPathsByHash = new Map();
  for (const [path, hash] of Object.entries(acceptedFiles)) {
    const paths = acceptedPathsByHash.get(hash) ?? [];
    paths.push(path);
    acceptedPathsByHash.set(hash, paths);
  }
  const deletedPaths = new Set(deleted.map((item) => item.path));
  const possibleRenames = [];
  const duplicateAdditions = [];
  const added = [];

  for (const path of addedCandidates) {
    const matchingPaths = acceptedPathsByHash.get(currentFiles[path]) ?? [];
    const renamedFrom = matchingPaths.filter((candidate) =>
      deletedPaths.has(candidate),
    );
    if (renamedFrom.length) {
      possibleRenames.push({
        from: renamedFrom,
        to: path,
        hash: currentFiles[path],
      });
    } else if (matchingPaths.length) {
      duplicateAdditions.push({
        existing: matchingPaths,
        added: path,
        hash: currentFiles[path],
      });
    } else {
      added.push(path);
    }
  }

  return {
    added,
    modified,
    deleted,
    possibleRenames,
    duplicateAdditions,
  };
}

export function appendNewRecords(existing, candidate, addedPaths, generatedAt) {
  const addedPathSet = new Set(addedPaths);
  const existingSourceIds = new Set(existing.sources.map((item) => item.id));
  const existingEventIds = new Set(existing.events.map((item) => item.id));
  const existingEntityIds = new Set(existing.entities.map((item) => item.id));
  const existingEventRelationIds = new Set(
    existing.eventRelations.map((item) => item.id),
  );
  const existingEntityRelationIds = new Set(
    existing.entityRelations.map((item) => item.id),
  );

  const sources = candidate.sources.filter(
    (source) =>
      addedPathSet.has(source.repositoryPath) &&
      !existingSourceIds.has(source.id),
  );
  const addedSourceIds = new Set(sources.map((item) => item.id));
  const events = candidate.events.filter(
    (event) =>
      event.sourceIds.some((sourceId) => addedSourceIds.has(sourceId)) &&
      !existingEventIds.has(event.id),
  );
  const addedEventIds = new Set(events.map((item) => item.id));
  const allEventIds = new Set([...existingEventIds, ...addedEventIds]);
  const referencedEntityIds = new Set(
    events.flatMap((event) => event.entityIds ?? []),
  );
  const entities = candidate.entities.filter(
    (entity) =>
      referencedEntityIds.has(entity.id) && !existingEntityIds.has(entity.id),
  );

  const eventRelations = candidate.eventRelations.filter(
    (relation) =>
      (addedEventIds.has(relation.from) || addedEventIds.has(relation.to)) &&
      allEventIds.has(relation.from) &&
      allEventIds.has(relation.to) &&
      !existingEventRelationIds.has(relation.id),
  );
  const entityRelations = candidate.entityRelations.filter(
    (relation) =>
      !existingEntityRelationIds.has(relation.id) &&
      (referencedEntityIds.has(relation.from) ||
        referencedEntityIds.has(relation.to)),
  );
  const mergedEvents = [...existing.events, ...events];
  const mergedEntities = [...existing.entities, ...entities];
  const eventCounts = new Map(mergedEntities.map((entity) => [entity.id, 0]));
  for (const event of mergedEvents) {
    for (const entityId of event.entityIds ?? []) {
      eventCounts.set(entityId, (eventCounts.get(entityId) ?? 0) + 1);
    }
  }
  const synchronizedEntities = mergedEntities.map((entity) =>
    synchronizeEntityEventCount(entity, eventCounts.get(entity.id) ?? 0),
  );
  const appendedEntities = synchronizedEntities.filter(
    (entity) => !existingEntityIds.has(entity.id),
  );

  return {
    kg: {
      ...existing,
      schemaVersion: candidate.schemaVersion,
      generatedAt,
      entities: synchronizedEntities,
      events: mergedEvents,
      eventRelations: [...existing.eventRelations, ...eventRelations],
      entityRelations: [...existing.entityRelations, ...entityRelations],
      sources: [...existing.sources, ...sources],
    },
    appended: {
      entities: appendedEntities,
      events,
      eventRelations,
      entityRelations,
      sources,
    },
  };
}

function synchronizeEntityEventCount(entity, eventCount) {
  if (
    !entity.extraction ||
    entity.extraction.eventCount === eventCount
  ) {
    return entity;
  }
  const materialized = materializeEntity({
    type: entity.type,
    label: entity.label,
    aliases: entity.aliases,
    method: entity.extraction.method,
    confidence: entity.extraction.confidence,
    eventCount,
  });
  return {
    ...entity,
    description: materialized.description,
    extraction: {
      ...entity.extraction,
      eventCount,
    },
  };
}

export function appendNewsRecords(
  existing,
  candidate,
  addedPaths,
  generatedAt,
) {
  const addedPathSet = new Set(addedPaths);
  const existingPageIds = new Set(existing.pages.map((item) => item.id));
  const existingNewsIds = new Set(existing.news.map((item) => item.id));
  const pages = candidate.pages.filter(
    (page) =>
      addedPathSet.has(page.repositoryPath) &&
      !existingPageIds.has(page.id),
  );
  const addedPageIds = new Set(pages.map((item) => item.id));
  const news = candidate.news.filter(
    (item) =>
      addedPageIds.has(item.pageId) && !existingNewsIds.has(item.id),
  );
  return {
    dataset: {
      ...existing,
      generatedAt,
      pages: [...existing.pages, ...pages],
      news: [...existing.news, ...news],
    },
    appended: { pages, news },
  };
}
