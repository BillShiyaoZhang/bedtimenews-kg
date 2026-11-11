import assert from "node:assert/strict";
import test from "node:test";
import { eventWithinYears, hasKnownPublicationDate } from "../app/lib/publication-date.mjs";
import { createEventSearchDocument, matchesSearchDocument, parseSearchQuery } from "../app/lib/search.mjs";

const event = (date, datePrecision = "day") => ({ date, datePrecision, title: "一般消息", summary: "介绍有关情况", type: "other" });

test("any active year bound excludes unknown precision and the legacy date sentinel", () => {
  for (const item of [event("1900-01-01", "unknown"), event("1900-01-01", "year"), event("1900-01-01"), event("2026-11-11", "unknown")]) {
    assert.equal(hasKnownPublicationDate(item), false);
    assert.equal(eventWithinYears(item), true, "unfiltered browsing must still include undated news");
    for (const [from, to] of [["1900", ""], ["", "2020"], ["1900", "1900"], ["2026", "2026"]]) assert.equal(eventWithinYears(item, from, to), false);
  }
});

test("year bounds are inclusive for known day, month, and year precision", () => {
  for (const precision of ["day", "month", "year"]) {
    const item = event("2020-01-01", precision);
    assert.equal(eventWithinYears(item, "2020", "2020"), true);
    assert.equal(eventWithinYears(item, "2021"), false);
    assert.equal(eventWithinYears(item, "", "2019"), false);
  }
});

test("search does not index unknown publication dates as 1900 or a purported known date", () => {
  for (const item of [event("1900-01-01", "unknown"), event("1900-01-01", "year"), event("2026-11-11", "unknown")]) {
    const doc = createEventSearchDocument({ event: item });
    assert.equal(doc.fields.date, "");
    assert.equal(matchesSearchDocument(doc, parseSearchQuery("1900")), false);
    assert.equal(matchesSearchDocument(doc, parseSearchQuery("2026")), false);
  }
  const known = createEventSearchDocument({ event: event("2026-11-11") });
  assert.equal(matchesSearchDocument(known, parseSearchQuery("2026")), true);
  const historicalContent = createEventSearchDocument({ event: { ...event("1900-01-01", "unknown"), title: "回顾1900年的历史" } });
  assert.equal(matchesSearchDocument(historicalContent, parseSearchQuery("1900")), true, "real content mentions remain searchable");
});
