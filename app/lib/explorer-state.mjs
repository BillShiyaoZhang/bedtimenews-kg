export const PAGE_SIZE = 20;
export const FILTER_KEYS = ["eventType", "subjectId", "placeId", "topicId", "objectId", "fromYear", "toYear", "actionConceptId", "actionStatus", "actionPolarity", "actionModality", "reportingFormConceptId", "reportingFormStatus", "numericStatus", "numericComparison"];
export const EMPTY_EXPLORER_FILTERS = {
  eventType: "", subjectId: "", placeId: "", topicId: "", objectId: "",
  fromYear: "", toYear: "", actionConceptId: "", actionStatus: "",
  actionPolarity: "", actionModality: "", reportingFormConceptId: "",
  reportingFormStatus: "", numericStatus: "", numericComparison: "",
};
const OWN_KEYS = ["q", "mode", "submitted", "feed", "sort", "page", ...FILTER_KEYS];
const FEEDS = new Set(["latest", "week", "month", "entities", "topics"]);

export function explorerNavigationState(current) {
  const next = { ...(current ?? {}) };
  delete next.atlasReader;
  return next;
}

// Retained filter-link API. Old links are validated with the same vocabulary
// as current combined keyword/facet searches; unsupported filters fail closed.
export function readExplorerLocation(search, ontology) {
  const parameters = new URLSearchParams(search);
  const mode = parameters.get("mode") === "filters" ? "filters" : "keyword";
  const filters = { ...EMPTY_EXPLORER_FILTERS };
  const invalidFilters = [];
  for (const key of FILTER_KEYS) filters[key] = parameters.get(key) ?? "";
  const allow = (key, ids) => {
    if (filters[key] && !ids.includes(filters[key])) { invalidFilters.push(key); filters[key] = ""; }
  };
  allow("eventType", ontology.eventTypes.map((entry) => entry.id));
  allow("topicId", ontology.hierarchies.topic.nodes.map((entry) => entry.id));
  allow("actionConceptId", ontology.hierarchies.action.nodes.map((entry) => entry.id));
  allow("actionStatus", ["applicable", "not_applicable", "undetermined"]);
  allow("actionPolarity", ["affirmative", "negated", "undetermined"]);
  allow("actionModality", ["reported", "planned", "predicted", "conditional", "undetermined"]);
  allow("reportingFormStatus", ["applicable", "not_applicable", "undetermined"]);
  allow("numericStatus", ["applicable", "undetermined"]);
  allow("numericComparison", ["year_over_year", "month_over_month"]);
  allow("reportingFormConceptId", ontology.reportingForm?.concepts.filter((entry) => entry.status === "active").map((entry) => entry.id) ?? []);
  for (const key of ["fromYear", "toYear"]) if (filters[key] && !/^\d{4}$/u.test(filters[key])) { invalidFilters.push(key); filters[key] = ""; }
  const query = parameters.get("q") ?? "";
  const submitted = mode === "keyword" ? (query.trim() ? { mode, query: query.trim() } : null) : (parameters.get("submitted") === "1" ? { mode, filters } : null);
  return { mode, query, filters, submitted, invalidFilters };
}

export function explorerLocationSearch(current, mode, search) {
  const parameters = new URLSearchParams(current);
  for (const key of ["mode", "q", "submitted", ...FILTER_KEYS]) parameters.delete(key);
  if (mode === "filters") parameters.set("mode", mode);
  if (search?.mode === "keyword") parameters.set("q", search.query);
  if (search?.mode === "filters") {
    parameters.set("submitted", "1");
    for (const [key, value] of Object.entries(search.filters)) if (value) parameters.set(key, value);
  }
  const output = parameters.toString();
  return output ? `?${output}` : "";
}

// Inspector navigation is deliberately excluded: opening a reader must not
// remount the search form and discard an unfinished query or filter draft.
export function explorerSearchKey(search) {
  const source = new URLSearchParams(search);
  const own = new URLSearchParams();
  for (const key of OWN_KEYS) if (source.has(key)) own.set(key, source.get(key));
  own.sort();
  return own.toString();
}

export function readBrowseLocation(search) {
  const parameters = new URLSearchParams(search);
  const query = (parameters.get("q") ?? "").trim();
  const feed = FEEDS.has(parameters.get("feed")) ? parameters.get("feed") : "latest";
  const sort = parameters.get("sort") === "relevance" && query ? "relevance" : "latest";
  const requestedPage = Number(parameters.get("page"));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  return { query, feed, sort, page };
}

export function writeBrowseLocation(current, state) {
  const parameters = new URLSearchParams(current);
  for (const key of OWN_KEYS) parameters.delete(key);
  const query = state.query.trim();
  if (query) parameters.set("q", query);
  if (state.feed !== "latest" && FEEDS.has(state.feed)) parameters.set("feed", state.feed);
  if (state.sort === "relevance" && query) parameters.set("sort", "relevance");
  if (state.page > 1) parameters.set("page", String(state.page));
  const filters = state.filters ?? {};
  for (const key of FILTER_KEYS) if (filters[key]) parameters.set(key, filters[key]);
  if (FILTER_KEYS.some((key) => filters[key])) parameters.set("submitted", "1");
  const output = parameters.toString();
  return output ? `?${output}` : "";
}

export function paginate(items, requestedPage, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.max(1, Math.min(pages, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  return { items: items.slice((page - 1) * size, page * size), page, pages, total: items.length };
}

export function localCalendarDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function getBeijingDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

// The window is inclusive of today and never promotes an imprecise year/month
// date to a current day. Date-only arithmetic avoids DST and timezone drift.
export function eventWithinDays(event, days, today = getBeijingDate()) {
  if (event.datePrecision !== "day" || !/^\d{4}-\d{2}-\d{2}$/u.test(event.date)) return false;
  const end = Date.parse(`${today}T00:00:00Z`);
  const point = Date.parse(`${event.date}T00:00:00Z`);
  return Number.isFinite(point) && Number.isFinite(end) && point <= end && point >= end - (days - 1) * 86400000;
}

/** Recent reporting activity is independent of release additions/restorations.
 * @param {Array<{date:string,datePrecision:string,entityIds:string[]}>} events
 */
export function recentEntityActivity(events, days = 30, today = getBeijingDate()) {
  /** @type {Map<string, {entityId:string, newsCount:number, latestDate:string}>} */
  const activity = new Map();
  for (const event of events) {
    if (!eventWithinDays(event, days, today)) continue;
    for (const entityId of new Set(event.entityIds)) {
      const previous = activity.get(entityId);
      activity.set(entityId, { entityId, newsCount: (previous?.newsCount ?? 0) + 1, latestDate: previous && previous.latestDate > event.date ? previous.latestDate : event.date });
    }
  }
  return [...activity.values()].sort((a, b) => b.latestDate.localeCompare(a.latestDate) || b.newsCount - a.newsCount || a.entityId.localeCompare(b.entityId));
}
