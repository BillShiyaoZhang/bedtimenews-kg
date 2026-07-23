import assert from "node:assert/strict";
import test from "node:test";
import {
  appendNewRecords,
  appendNewsRecords,
  classifyArchiveChanges,
} from "../scripts/lib/incremental.mjs";

test("archive changes separate safe additions from edits, deletions, and renames", () => {
  const accepted = {
    "main/1.md": "hash-1",
    "main/2.md": "hash-2",
    "main/3.md": "hash-3",
  };
  const current = {
    "main/1.md": "changed",
    "main/3-renamed.md": "hash-3",
    "main/4.md": "hash-4",
  };

  assert.deepEqual(classifyArchiveChanges(accepted, current), {
    added: ["main/4.md"],
    modified: [
      {
        path: "main/1.md",
        acceptedHash: "hash-1",
        currentHash: "changed",
      },
    ],
    deleted: [
      { path: "main/2.md", acceptedHash: "hash-2" },
      { path: "main/3.md", acceptedHash: "hash-3" },
    ],
    possibleRenames: [
      {
        from: ["main/3.md"],
        to: "main/3-renamed.md",
        hash: "hash-3",
      },
    ],
    duplicateAdditions: [],
  });
});

test("incremental merge appends new records without replacing existing records", () => {
  const existing = knowledgeBase({
    entities: [{ id: "entity-old" }],
    events: [{ id: "event-old", entityIds: ["entity-old"], sourceIds: ["source-old"] }],
    eventRelations: [{ id: "relation-old", from: "event-old", to: "event-old" }],
    sources: [{ id: "source-old", repositoryPath: "main/1.md" }],
  });
  const candidate = knowledgeBase({
    entities: [{ id: "entity-new" }],
    events: [
      { id: "event-old-rebuilt", entityIds: [], sourceIds: ["source-old"] },
      { id: "event-new", entityIds: ["entity-new"], sourceIds: ["source-new"] },
    ],
    eventRelations: [
      { id: "relation-new", from: "event-old", to: "event-new" },
    ],
    sources: [
      { id: "source-old", repositoryPath: "main/1.md" },
      { id: "source-new", repositoryPath: "main/2.md" },
    ],
  });

  const { kg, appended } = appendNewRecords(
    existing,
    candidate,
    ["main/2.md"],
    "2026-07-23T00:00:00Z",
  );

  assert.equal(kg.events[0], existing.events[0]);
  assert.deepEqual(kg.events.map((event) => event.id), [
    "event-old",
    "event-new",
  ]);
  assert.deepEqual(kg.eventRelations.map((relation) => relation.id), [
    "relation-old",
    "relation-new",
  ]);
  assert.deepEqual(appended.entities.map((entity) => entity.id), ["entity-new"]);
});

test("processed news dataset appends items only from new referenced pages", () => {
  const existing = {
    schemaVersion: "1.1.0",
    generatedAt: "2026-01-01T00:00:00Z",
    pages: [{ id: "page-old", repositoryPath: "main/1.md" }],
    news: [{ id: "news-old", pageId: "page-old" }],
  };
  const candidate = {
    ...existing,
    pages: [
      ...existing.pages,
      { id: "page-new", repositoryPath: "main/2.md" },
      { id: "page-ignored", repositoryPath: "main/3.md" },
    ],
    news: [
      ...existing.news,
      { id: "news-new-1", pageId: "page-new" },
      { id: "news-new-2", pageId: "page-new" },
      { id: "news-ignored", pageId: "page-ignored" },
    ],
  };

  const { dataset, appended } = appendNewsRecords(
    existing,
    candidate,
    ["main/2.md"],
    "2026-07-23T00:00:00Z",
  );

  assert.equal(dataset.news[0], existing.news[0]);
  assert.deepEqual(
    dataset.news.map((item) => item.id),
    ["news-old", "news-new-1", "news-new-2"],
  );
  assert.deepEqual(
    appended.pages.map((page) => page.id),
    ["page-new"],
  );
});

function knowledgeBase(overrides) {
  return {
    schemaVersion: "0.1.0",
    generatedAt: "2026-01-01T00:00:00Z",
    source: {},
    entities: [],
    events: [],
    eventRelations: [],
    entityRelations: [],
    sources: [],
    ...overrides,
  };
}
