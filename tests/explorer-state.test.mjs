import assert from "node:assert/strict";
import test from "node:test";
import { explorerSearchKey, readBrowseLocation, writeBrowseLocation, explorerNavigationState, paginate, eventWithinDays, getBeijingDate, recentEntityActivity, EMPTY_EXPLORER_FILTERS } from "../app/lib/explorer-state.mjs";

test("home navigation drops reader ownership without mutating the entry being left", () => {
  const prior = { __NA: true, atlasReader: { base: "/?feed=week", owned: true }, custom: "keep" };
  assert.deepEqual(explorerNavigationState(prior), { __NA: true, custom: "keep" });
  assert.deepEqual(prior.atlasReader, { base: "/?feed=week", owned: true });
  assert.deepEqual(explorerNavigationState(null), {});
});

test("reader navigation does not change the home search key", () => {
  const draft = "?q=武汉&topicId=health&page=2";
  assert.equal(explorerSearchKey(draft), explorerSearchKey(`${draft}&news=news-a&entity=entity-b&panel=news`));
  assert.equal(explorerSearchKey(draft), explorerSearchKey(`${draft}&inspectEntity=entity-b`));
  assert.notEqual(explorerSearchKey(draft), explorerSearchKey("?q=武汉&page=3"));
});

test("combined keyword and filters round-trip with paging and preserve unrelated URL state", () => {
  const filters = { ...EMPTY_EXPLORER_FILTERS, topicId: "health", fromYear: "2020" };
  const url = writeBrowseLocation("?entity=a&legacy=keep&q=old&page=9", { query: "武汉 疫情", feed: "week", sort: "relevance", page: 2, filters });
  const parameters = new URLSearchParams(url);
  assert.equal(parameters.get("entity"), "a");
  assert.equal(parameters.get("legacy"), "keep");
  assert.equal(parameters.get("topicId"), "health");
  assert.deepEqual(readBrowseLocation(url), { query: "武汉 疫情", feed: "week", sort: "relevance", page: 2 });
  const reset = writeBrowseLocation(url, { query: "", feed: "latest", sort: "latest", page: 1, filters: EMPTY_EXPLORER_FILTERS });
  assert.equal(new URLSearchParams(reset).get("topicId"), null);
  assert.equal(new URLSearchParams(reset).get("entity"), "a");
});

test("stale or hand-edited paging and sorting are safe", () => {
  assert.deepEqual(readBrowseLocation("?feed=invalid&page=-2&sort=relevance"), { query: "", feed: "latest", page: 1, sort: "latest" });
  const items = Array.from({ length: 43 }, (_, i) => i);
  assert.deepEqual(paginate(items, 99), { items: [40, 41, 42], page: 3, pages: 3, total: 43 });
  assert.equal(paginate(items, 2).items[0], 20);
  assert.deepEqual(paginate([], 8), { items: [], page: 1, pages: 1, total: 0 });
});

test("recent windows include the boundary but exclude future and imprecise dates", () => {
  const day = (date, datePrecision = "day") => ({ date, datePrecision });
  assert.equal(eventWithinDays(day("2026-10-14"), 7, "2026-10-14"), true);
  assert.equal(eventWithinDays(day("2026-10-08"), 7, "2026-10-14"), true);
  assert.equal(eventWithinDays(day("2026-10-07"), 7, "2026-10-14"), false);
  assert.equal(eventWithinDays(day("2026-10-15"), 30, "2026-10-14"), false);
  assert.equal(eventWithinDays(day("2026-10-01", "month"), 30, "2026-10-14"), false);
  assert.equal(eventWithinDays(day("bad"), 7, "2026-10-14"), false);
});

test("recent entity and topic activity follows Beijing days without inventing release additions", () => {
  assert.equal(getBeijingDate(new Date("2026-10-13T16:30:00Z")), "2026-10-14");
  assert.equal(getBeijingDate(new Date("2026-10-13T15:59:00Z")), "2026-10-13");
  const event = (date, entityIds, datePrecision = "day") => ({ date, entityIds, datePrecision });
  const rows = recentEntityActivity([
    event("2026-10-12", ["entity-a", "entity-a", "topic-a"]),
    event("2026-09-15", ["entity-a", "entity-b"]),
    event("2026-09-14", ["old-entity"]),
    event("2026-10-15", ["future-entity"]),
    event("2026-10-01", ["imprecise-entity"], "month"),
  ], 30, "2026-10-14");
  assert.deepEqual(rows, [
    { entityId: "entity-a", newsCount: 2, latestDate: "2026-10-12" },
    { entityId: "topic-a", newsCount: 1, latestDate: "2026-10-12" },
    { entityId: "entity-b", newsCount: 1, latestDate: "2026-09-15" },
  ]);
  assert.ok(rows.every((row) => !("added" in row) && !("restored" in row)));
  assert.deepEqual(recentEntityActivity([event("2024-01-01", ["old"])], 30, "2026-10-14"), []);
});
