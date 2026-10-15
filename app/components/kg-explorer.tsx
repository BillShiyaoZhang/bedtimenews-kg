"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import {
  formatEventDate,
  type Entity,
  type Event,
  type ActionFilter,
  type ActionAssignment,
  type KnowledgeBase,
  type Ontology,
} from "../lib/kg";
import {
  createEntitySearchDocument,
  createEventSearchDocument,
  matchesSearchDocument,
  parseSearchQuery,
  rankEntitySearchDocument,
  rankEventSearchDocument,
} from "../lib/search.mjs";

import { topicEntityIds, topicMatchReason } from "../lib/ontology-hierarchy.mjs";
import { actionAssessmentLabel, actionFilterOptions, actionMatchReasons, eventMatchesAction } from "../lib/action-assessment.mjs";

import { eventMatchesReportingForm, eventMatchesNumericObservation } from "../lib/report-description-assessment.mjs";
import { useReader } from "./reader-provider";
import { PAGE_SIZE, readExplorerLocation, explorerSearchKey, readBrowseLocation, writeBrowseLocation, explorerNavigationState, paginate, eventWithinDays, getBeijingDate, recentEntityActivity } from "../lib/explorer-state.mjs";

type Filters = {
  eventType: string;
  subjectId: string;
  placeId: string;
  topicId: string;
  objectId: string;
  fromYear: string;
  toYear: string;
  actionConceptId: string;
  actionStatus: string;
  actionPolarity: string;
  actionModality: string;
  reportingFormConceptId: string;
  reportingFormStatus: string;
  numericStatus: string;
  numericComparison: string;
};

const EMPTY_FILTERS: Filters = {
  eventType: "",
  subjectId: "",
  placeId: "",
  topicId: "",
  objectId: "",
  fromYear: "",
  toYear: "",
  actionConceptId: "",
  actionStatus: "",
  actionPolarity: "",
  actionModality: "",
  reportingFormConceptId: "",
  reportingFormStatus: "",
  numericStatus: "",
  numericComparison: "",
};
const actionFilter = (filters: Filters): ActionFilter => ({ conceptId: filters.actionConceptId, status: filters.actionStatus, polarity: filters.actionPolarity, modality: filters.actionModality });



const SEARCH_LOCATION_EVENT = "kg-search-location-change";
function subscribeToSearchLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener(SEARCH_LOCATION_EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(SEARCH_LOCATION_EVENT, callback);
  };
}
const getSearchLocation = () => window.location.search;
const getServerSearchLocation = () => "";

export { readExplorerLocation, explorerLocationSearch } from "../lib/explorer-state.mjs";

export type ExplorerUpdateIndex = {
  recorded?: boolean;
  addedNewsIds: string[];
  addedEntityIds: string[];
  restoredNewsIds: string[];
  restoredEntityIds: string[];
  knownNewsIds: string[];
  knownEntityIds: string[];
};
type ExplorerProps = { initialKG: KnowledgeBase; initialOntology: Ontology; updateIndex?: ExplorerUpdateIndex };
type Feed = "latest" | "week" | "month" | "entities" | "topics";
type Sort = "latest" | "relevance";
const eventSearchCache = new WeakMap<KnowledgeBase, WeakMap<Ontology, ReturnType<typeof createEventSearchDocument>[]>>();
const entityOptionsCache = new WeakMap<KnowledgeBase, WeakMap<Ontology, { subjects: Entity[]; places: Entity[]; objects: Entity[] }>>();
const actionOptionsCache = new WeakMap<KnowledgeBase, WeakMap<Ontology, ReturnType<typeof actionFilterOptions>>>();

export function KGExplorer(props: ExplorerProps) {
  const locationSearch = useSyncExternalStore(subscribeToSearchLocation, getSearchLocation, getServerSearchLocation);
  return <KGExplorerView key={explorerSearchKey(locationSearch)} {...props} locationSearch={locationSearch} />;
}

function KGExplorerView({ initialKG, initialOntology, updateIndex, locationSearch }: ExplorerProps & { locationSearch: string }) {
  const reader = useReader();
  const initial = useMemo(() => readExplorerLocation(locationSearch, initialOntology), [locationSearch, initialOntology]);
  const browse = useMemo(() => readBrowseLocation(locationSearch), [locationSearch]);
  const feed = browse.feed as Feed;
  const sort = browse.sort as Sort;
  const [query, setQuery] = useState(browse.query);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const appliedFilters = initial.filters;
  const entityById = useMemo(() => new Map(initialKG.entities.map((entity) => [entity.id, entity])), [initialKG.entities]);
  const sourceById = useMemo(() => new Map(initialKG.sources.map((source) => [source.id, source])), [initialKG.sources]);
  const eventTypeById = useMemo(() => new Map(initialOntology.eventTypes.map((type) => [type.id, type])), [initialOntology.eventTypes]);
  const entityTypeById = useMemo(() => new Map(initialOntology.entityTypes.map((type) => [type.id, type])), [initialOntology.entityTypes]);
  const invalidFilters = [...initial.invalidFilters];
  for (const key of ["subjectId", "placeId", "objectId"] as const) if (appliedFilters[key] && !entityById.has(appliedFilters[key])) invalidFilters.push(key);
  if (appliedFilters.fromYear && appliedFilters.toYear && appliedFilters.fromYear > appliedFilters.toYear) invalidFilters.push("yearRange");
  const invalidLocation = invalidFilters.length > 0;
  const today = getBeijingDate();
  const latestEvent = useMemo(() => initialKG.events.reduce<Event | undefined>((latest, event) => !latest || event.date > latest.date ? event : latest, undefined), [initialKG.events]);
  const filterCount = Object.values(appliedFilters).filter(Boolean).length;
  const hasSearch = !!browse.query || filterCount > 0;
  const updateRecorded = updateIndex?.recorded === true;
  const addedEntities = useMemo(() => new Set(updateRecorded ? [...(updateIndex?.addedEntityIds ?? []), ...(updateIndex?.restoredEntityIds ?? [])] : []), [updateIndex, updateRecorded]);
  const showRecentEntities = feed === "entities" && addedEntities.size === 0;
  const recentActivity = useMemo(() => showRecentEntities ? recentEntityActivity(initialKG.events, 30, today) : [], [showRecentEntities, initialKG.events, today]);
  const recentById = useMemo(() => new Map(recentActivity.map((row) => [row.entityId, row])), [recentActivity]);

  const entitiesByType = useMemo(() => {
    const cache = entityOptionsCache.get(initialKG) ?? new WeakMap<Ontology, { subjects: Entity[]; places: Entity[]; objects: Entity[] }>();
    const saved = cache.get(initialOntology);
    if (saved) return saved;
    const counts = new Map<string, number>();
    for (const event of initialKG.events) for (const id of event.entityIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const options = (facetId: string) => {
      const types = initialOntology.facets.find((facet) => facet.id === facetId)?.entityTypes ?? [];
      return initialKG.entities.filter((entity) => types.includes(entity.type) && counts.has(entity.id))
        .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.label.localeCompare(b.label, "zh-CN"));
    };
    const result = { subjects: options("subject"), places: options("place"), objects: options("named_object") };
    cache.set(initialOntology, result);
    entityOptionsCache.set(initialKG, cache);
    return result;
  }, [initialKG, initialOntology]);
  const topicOptions = useMemo(() => {
    const hierarchy = initialOntology.hierarchies.topic;
    const options: { id: string; label: string }[] = [];
    const visit = (parentId: string, depth: number) => {
      for (const node of hierarchy.nodes.filter((entry) => entry.primaryParentId === parentId && entry.status === "active")) {
        options.push({ id: node.id, label: `${"　".repeat(depth)}${node.label}${node.abstract ? "（含下级）" : ""}` });
        visit(node.id, depth + 1);
      }
    };
    visit(hierarchy.rootId, 0);
    return options;
  }, [initialOntology]);
  const actionOptions = useMemo(() => {
    const cache = actionOptionsCache.get(initialKG) ?? new WeakMap<Ontology, ReturnType<typeof actionFilterOptions>>();
    const saved = cache.get(initialOntology);
    if (saved) return saved;
    const result = actionFilterOptions(initialOntology, initialKG.events);
    cache.set(initialOntology, result); actionOptionsCache.set(initialKG, cache);
    return result;
  }, [initialOntology, initialKG]);
  const documents = useMemo(() => {
    // Daily browsing does not pay the cost of constructing a full text index.
    if (!browse.query) return initialKG.events.map((event) => ({ event }));
    const cache = eventSearchCache.get(initialKG) ?? new WeakMap<Ontology, ReturnType<typeof createEventSearchDocument>[]>();
    const saved = cache.get(initialOntology);
    if (saved) return saved;
    const result = initialKG.events.map((event) => {
      const entities = event.entityIds.map((id) => entityById.get(id)).filter(Boolean) as Entity[];
      return createEventSearchDocument({ event, entities, source: sourceById.get(event.sourceIds[0]), eventType: eventTypeById.get(event.type), entityTypes: entities.map((entity) => entityTypeById.get(entity.type)).filter(Boolean) });
    });
    cache.set(initialOntology, result); eventSearchCache.set(initialKG, cache);
    return result;
  }, [initialKG, initialOntology, browse.query, entityById, sourceById, eventTypeById, entityTypeById]);
  const result = useMemo(() => {
    if (invalidLocation) return [] as Event[];
    const terms = parseSearchQuery(browse.query);
    const selectedTopicIds = appliedFilters.topicId ? new Set(topicEntityIds(initialOntology, appliedFilters.topicId)) : null;
    const matches = documents.filter((document) => {
      const event = document.event;
      if (browse.query && !matchesSearchDocument(document, terms)) return false;
      if (feed === "week" && !eventWithinDays(event, 7, today)) return false;
      if (feed === "month" && !eventWithinDays(event, 30, today)) return false;
      if (appliedFilters.eventType && event.type !== appliedFilters.eventType) return false;
      for (const id of [appliedFilters.subjectId, appliedFilters.placeId, appliedFilters.objectId]) if (id && !event.entityIds.includes(id)) return false;
      if (selectedTopicIds && !event.entityIds.some((id: string) => selectedTopicIds.has(id))) return false;
      if (!eventMatchesAction(initialOntology, event, actionFilter(appliedFilters))) return false;
      if (!eventMatchesReportingForm(event, { status: appliedFilters.reportingFormStatus, conceptId: appliedFilters.reportingFormConceptId })) return false;
      if (!eventMatchesNumericObservation(event, { status: appliedFilters.numericStatus, comparison: appliedFilters.numericComparison })) return false;
      const year = event.date.slice(0, 4);
      return (!appliedFilters.fromYear || year >= appliedFilters.fromYear) && (!appliedFilters.toYear || year <= appliedFilters.toYear);
    });
    return matches.sort((a, b) => (sort === "relevance" ? rankEventSearchDocument(b, browse.query) - rankEventSearchDocument(a, browse.query) : 0) || b.event.date.localeCompare(a.event.date) || a.event.title.localeCompare(b.event.title, "zh-CN")).map(({ event }) => event);
  }, [documents, browse.query, sort, feed, appliedFilters, initialOntology, invalidLocation, today]);
  const entityMatches = useMemo(() => {
    if (!browse.query && feed !== "entities") return [] as Entity[];
    const terms = parseSearchQuery(browse.query);
    return initialKG.entities.filter((entity) => feed !== "entities" || (showRecentEntities ? recentById.has(entity.id) : addedEntities.has(entity.id))).map((entity) => createEntitySearchDocument(entity, entityTypeById.get(entity.type)))
      .filter((document) => !browse.query || matchesSearchDocument(document, terms))
      .sort((a, b) => rankEntitySearchDocument(b, browse.query) - rankEntitySearchDocument(a, browse.query)
        || (showRecentEntities ? (recentById.get(b.entity.id)?.latestDate ?? "").localeCompare(recentById.get(a.entity.id)?.latestDate ?? "") || (recentById.get(b.entity.id)?.newsCount ?? 0) - (recentById.get(a.entity.id)?.newsCount ?? 0) : 0)
        || (b.entity.identityResolution?.newsCount ?? b.entity.extraction?.eventCount ?? 0) - (a.entity.identityResolution?.newsCount ?? a.entity.extraction?.eventCount ?? 0) || a.entity.label.localeCompare(b.entity.label, "zh-CN"))
      .map(({ entity }) => entity);
  }, [initialKG.entities, entityTypeById, browse.query, feed, addedEntities, showRecentEntities, recentById]);
  const newsPage = paginate(result, browse.page);
  const entityPage = paginate(entityMatches, browse.page);
  const topicCounts = useMemo(() => feed !== "topics" ? new Map<string, number>() : new Map(initialOntology.hierarchies.topic.nodes.map((node) => {
    const ids = new Set(topicEntityIds(initialOntology, node.id));
    return [node.id, initialKG.events.filter((event) => event.entityIds.some((id) => ids.has(id))).length];
  })), [initialKG.events, initialOntology, feed]);

  const navigate = (next: { query?: string; filters?: Filters; feed?: Feed; sort?: Sort; page?: number }) => {
    const url = new URL(window.location.href);
    const search = writeBrowseLocation(url.search, { query: next.query ?? browse.query, filters: next.filters ?? appliedFilters, feed: next.feed ?? feed, sort: next.sort ?? sort, page: next.page ?? 1 });
    if (url.search === search) return;
    url.search = search;
    window.history.pushState(explorerNavigationState(window.history.state), "", url);
    window.dispatchEvent(new window.Event(SEARCH_LOCATION_EVENT));
    window.requestAnimationFrame(() => {
      const results = document.getElementById("news-results");
      results?.scrollIntoView({ block: "start", behavior: "auto" });
      const heading = results?.querySelector<HTMLElement>("h2");
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (filters.fromYear && filters.toYear && filters.fromYear > filters.toYear) { setError("起始年份不能晚于结束年份。"); return; }
    setError("");
    navigate({ query: query.trim(), filters, feed: ["entities", "topics"].includes(feed) ? "latest" : feed, sort: query.trim() ? "relevance" : "latest" });
  };
  const selectFeed = (next: Feed) => navigate({ feed: next, query: "", filters: { ...EMPTY_FILTERS }, sort: "latest" });
  const updateFilter = (key: keyof Filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const reset = () => { setQuery(""); setFilters({ ...EMPTY_FILTERS }); setError(""); navigate({ query: "", filters: { ...EMPTY_FILTERS }, feed: "latest", sort: "latest" }); };
  const pagination = (page: ReturnType<typeof paginate>) => page.pages > 1 ? <nav className="news-pagination" aria-label="结果分页"><button type="button" disabled={page.page === 1} onClick={() => navigate({ page: page.page - 1 })}>上一页</button><span>第 {page.page} / {page.pages} 页 · 共 {page.total.toLocaleString("zh-CN")} 条</span><button type="button" disabled={page.page === page.pages} onClick={() => navigate({ page: page.page + 1 })}>下一页</button></nav> : null;

  return <main className="search-page">
    <a className="skip-link" href="#news-results">跳到新闻列表</a>
    <header className="site-header home-header">
      <Link prefetch={false} className="brand" href="/" aria-label="历史经纬首页"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span><strong>历史经纬</strong><small>新闻与知识的连接</small></span></Link>
      <nav aria-label="主要导航"><Link prefetch={false} href="/graph/">探索关系</Link><Link prefetch={false} href="/ontology/">知识分类</Link><a className="archive-link" href={initialKG.source.url} target="_blank" rel="noreferrer">原始档案 ↗</a></nav>
    </header>
    <section className="search-hero" aria-label="新闻检索">
      <div className="hero-copy"><h1>新闻有来处，线索有连接。</h1><p>搜索你关心的事，或从最新收录的新闻开始。</p></div>
      <form className="home-search-form" onSubmit={submit}>
        <div className="keyword-search"><label className="sr-only" htmlFor="keyword">搜索新闻、人物、地点或议题</label><div><span className="search-icon" aria-hidden="true" /><input id="keyword" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索新闻、人物、地点或议题" autoComplete="off" /><button type="submit">搜索</button></div><small>多个关键词同时匹配，例如：武汉 住房。</small></div>
        <details className="common-filters" open={filterCount > 0 || undefined}><summary>筛选条件{filterCount > 0 ? ` · 已应用 ${filterCount} 项` : ""}</summary><div className="filter-search">
          <FilterSelect id="event-type" label="报道领域" value={filters.eventType} onChange={(value) => updateFilter("eventType", value)} options={initialOntology.eventTypes} placeholder="全部领域" />
          <FilterSelect id="subject" label="人物或组织" value={filters.subjectId} onChange={(value) => updateFilter("subjectId", value)} options={entitiesByType.subjects} placeholder="全部人物与组织" />
          <FilterSelect id="place" label="地点" value={filters.placeId} onChange={(value) => updateFilter("placeId", value)} options={entitiesByType.places} placeholder="全部地点" />
          <FilterSelect id="topic" label="议题" value={filters.topicId} onChange={(value) => updateFilter("topicId", value)} options={topicOptions} placeholder="全部议题" />
          <div className="year-range"><span>年份范围</span><div><label><span className="sr-only">起始年份</span><input inputMode="numeric" pattern="[0-9]{4}" value={filters.fromYear} onChange={(event) => updateFilter("fromYear", event.target.value.replace(/\D/gu, "").slice(0, 4))} placeholder="起始年份" /></label><i aria-hidden="true">—</i><label><span className="sr-only">结束年份</span><input inputMode="numeric" pattern="[0-9]{4}" value={filters.toYear} onChange={(event) => updateFilter("toYear", event.target.value.replace(/\D/gu, "").slice(0, 4))} placeholder="结束年份" /></label></div></div>
          <FilterSelect id="object" label="政策、设施或文献" value={filters.objectId} onChange={(value) => updateFilter("objectId", value)} options={entitiesByType.objects} placeholder="全部对象" />
        </div><details className="advanced-filters"><summary>高级筛选 · 报道描述与证据</summary><p>以下条件描述本条报道的文字，不表示现实已发生或得到独立证实。</p><div className="filter-search">
          <FilterSelect id="action-concept" label="行动或变化" value={filters.actionConceptId} onChange={(value) => updateFilter("actionConceptId", value)} options={actionOptions} placeholder="全部受支持类别" />
          <FilterSelect id="action-status" label="行动评估状态" value={filters.actionStatus} onChange={(value) => updateFilter("actionStatus", value)} options={initialOntology.actionAssessment?.statuses ?? []} placeholder="全部状态" />
          <FilterSelect id="action-polarity" label="肯定或否定" value={filters.actionPolarity} onChange={(value) => updateFilter("actionPolarity", value)} options={initialOntology.actionAssessment?.polarities ?? []} placeholder="全部极性" />
          <FilterSelect id="action-modality" label="实际报道或计划" value={filters.actionModality} onChange={(value) => updateFilter("actionModality", value)} options={initialOntology.actionAssessment?.modalities ?? []} placeholder="全部模态" />
          <FilterSelect id="reporting-form" label="报道形式" value={filters.reportingFormConceptId} onChange={(value) => updateFilter("reportingFormConceptId", value)} options={initialOntology.reportingForm?.concepts.filter((entry) => entry.status === "active") ?? []} placeholder="全部审查标签" />
          <FilterSelect id="reporting-form-status" label="形式审查状态" value={filters.reportingFormStatus} onChange={(value) => updateFilter("reportingFormStatus", value)} options={[{ id: "applicable", label: "已有审查标签" }, { id: "undetermined", label: "尚未确定" }, { id: "not_applicable", label: "经审查不适用" }]} placeholder="全部状态" />
          <FilterSelect id="numeric-status" label="数值描述状态" value={filters.numericStatus} onChange={(value) => updateFilter("numericStatus", value)} options={[{ id: "applicable", label: "已有受支持描述" }, { id: "undetermined", label: "尚未确定" }]} placeholder="全部状态" />
          <FilterSelect id="numeric-comparison" label="数值比较方式" value={filters.numericComparison} onChange={(value) => updateFilter("numericComparison", value)} options={[{ id: "year_over_year", label: "同比" }, { id: "month_over_month", label: "环比" }]} placeholder="全部比较方式" />
        </div></details><div className="filter-actions"><button type="button" onClick={reset}>清空检索</button><button type="submit">应用条件</button></div></details>
        {error && <p role="alert" className="invalid-filter-notice">{error}</p>}
      </form>
      <div className="library-freshness"><span>共 {initialKG.events.length.toLocaleString("zh-CN")} 条新闻</span>{latestEvent && <span>最新新闻日期：{formatEventDate(latestEvent)}</span>}<span>{updateRecorded ? "本版本更新记录可用" : "本版本更新信息未记录"}</span></div>
    </section>
    <section className="results-section" id="news-results" aria-label="浏览新闻与知识">
      <div className="browse-controls"><nav className="quick-filters" aria-label="快速浏览">{([{ id: "latest", label: "最新新闻" }, { id: "week", label: "近 7 天" }, { id: "month", label: "近 30 天" }, { id: "entities", label: "新实体" }, { id: "topics", label: "议题标签" }] as { id: Feed; label: string }[]).map((item) => <button type="button" aria-pressed={feed === item.id} className={feed === item.id ? "active" : ""} key={item.id} onClick={() => selectFeed(item.id)}>{item.label}{item.id === "entities" && updateRecorded && addedEntities.size > 0 && <span className="count-badge">{addedEntities.size}</span>}</button>)}</nav><span className="reading-update-count">{reader.hasPreviousVisit ? (!updateRecorded || reader.updateRecorded === false ? "本版本更新信息未记录" : reader.newCount ? `上次访问后新增 ${reader.newCount} 条` : "上次访问后暂无新增") : "从最新新闻开始"}</span></div>
      {invalidLocation && <p className="invalid-filter-notice" role="status">链接含有当前版本不支持的筛选条件，未扩大匹配范围。<button type="button" onClick={reset}>清空后重新检索</button></p>}
      {feed === "entities" ? <>
        <div className="results-heading"><div><span className="eyebrow">知识更新</span><h2>{showRecentEntities ? "近期有新报道的实体与议题" : "本版本新增与恢复的实体"}</h2></div><p>点击实体，在当前界面查看相关新闻。</p></div>
        <p className="entity-update-note" role="status">{updateRecorded ? (showRecentEntities ? "本版本没有新增或恢复的实体。" : `共 ${entityMatches.length} 个新增或恢复的实体与议题。`) : "本版本更新信息未记录。"}{showRecentEntities && ` 下方展示近 30 天有报道关联的实体与议题，截至北京时间 ${today}。`}</p>
        {entityPage.items.length ? <>
          <div className="entity-result-grid">{(entityPage.items as Entity[]).map((entity) => <button className="entity-result-card" type="button" key={entity.id} onClick={() => reader.openEntity(entity.id)}>
            <span>{entityTypeById.get(entity.type)?.label ?? entity.type}</span><strong>{entity.label}</strong>
            {showRecentEntities ? <><span className="recent-entity-label">近期有新报道</span><small>近 30 天 {recentById.get(entity.id)?.newsCount ?? 0} 条报道 · 最近 {recentById.get(entity.id)?.latestDate}</small></> : <small>{updateIndex?.restoredEntityIds.includes(entity.id) ? "本版本恢复" : "本版本新增"} · 关联 {entity.identityResolution?.newsCount ?? entity.extraction?.eventCount ?? 0} 条新闻</small>}
            <i aria-hidden="true">查看相关新闻 →</i>
          </button>)}</div>{pagination(entityPage)}
        </> : <div className="empty-result"><strong>{showRecentEntities ? "近 30 天暂无新报道" : "没有匹配的新增实体或议题"}</strong><p>仍可按议题浏览已有新闻。</p><button type="button" onClick={() => selectFeed("topics")}>浏览全部议题</button></div>}
      </> : feed === "topics" ? <><div className="results-heading"><div><span className="eyebrow">按兴趣阅读</span><h2>从一个议题开始</h2></div><p>上位议题同时包含下级议题的新闻。</p></div><div className="topic-browse-grid">{initialOntology.hierarchies.topic.nodes.filter((node) => node.status === "active" && node.id !== initialOntology.hierarchies.topic.rootId).map((topic) => <button key={topic.id} type="button" onClick={() => navigate({ feed: "latest", query: "", filters: { ...EMPTY_FILTERS, topicId: topic.id }, sort: "latest" })}><strong>{topic.label}</strong><span>{(topicCounts.get(topic.id) ?? 0).toLocaleString("zh-CN")} 条新闻</span>{topic.description && <small>{topic.description}</small>}</button>)}</div></> : <>
        <div className="results-heading"><div className="results-title-row"><h2>{hasSearch ? "检索结果" : feed === "week" ? "近 7 天新闻" : feed === "month" ? "近 30 天新闻" : "最新新闻"}</h2><span className="results-total">共 {result.length.toLocaleString("zh-CN")} 条新闻</span></div><label className="sort-control">排序<select value={sort} onChange={(event) => navigate({ sort: event.target.value as Sort })}><option value="latest">最新优先</option>{browse.query && <option value="relevance">相关度优先</option>}</select></label></div>
        <p className="result-count-status" role="status">{result.length ? `显示第 ${(newsPage.page - 1) * PAGE_SIZE + 1}–${Math.min(newsPage.page * PAGE_SIZE, result.length)} 条，${sort === "relevance" ? "按相关度排序" : "按新闻日期排序"}。` : "没有匹配的新闻。"}{["week", "month"].includes(feed) ? " 日期不精确的新闻不计入近期范围。" : ""}</p>
        {hasSearch && entityMatches.length > 0 && <div className="related-entity-strip"><span>相关实体</span>{entityMatches.slice(0, 6).map((entity) => <button key={entity.id} type="button" onClick={() => reader.openEntity(entity.id)}>{entity.label}</button>)}{entityMatches.length > 6 && <Link prefetch={false} href={`/graph/?q=${encodeURIComponent(browse.query)}`}>更多实体 →</Link>}</div>}
        {newsPage.items.length ? <><div className="result-list">{(newsPage.items as Event[]).map((event) => {
          const source = sourceById.get(event.sourceIds[0]);
          const entities = event.entityIds.map((id) => entityById.get(id)).filter(Boolean) as Entity[];
          const eventType = eventTypeById.get(event.type);
          return <article className={`result-card${reader.isRead(event.newsId) ? " is-read" : ""}`} key={event.id}><div className="result-date"><time>{formatEventDate(event)}</time></div><div className="result-content"><div className="result-meta"><span style={{ "--type-color": eventType?.color } as CSSProperties}>{eventType?.label ?? event.type}</span>{source?.episode && <i>睡前消息 {source.episode.number} 期</i>}{reader.isNew(event.newsId) && <span className="new-badge">新收录</span>}{reader.isRead(event.newsId) && <span className="read-badge">已读</span>}</div><h3><Link prefetch={false} className="news-title-link" href={`/news/${encodeURIComponent(event.newsId)}/`} onClick={(click) => reader.openNews(event.newsId, click)}>{event.title}</Link></h3>{appliedFilters.topicId && <small className="topic-match-reason">议题：{topicMatchReason(initialOntology, event, appliedFilters.topicId).map((match) => match.label).join("、")}</small>}<p className="news-excerpt"><Link prefetch={false} className="news-summary-link" href={`/news/${encodeURIComponent(event.newsId)}/`} onClick={(click) => reader.openNews(event.newsId, click)}>{event.summary || "打开新闻查看完整原文片段。"}</Link></p><div className="entity-tags">{entities.slice(0, 6).map((entity) => <button type="button" key={entity.id} onClick={() => reader.openEntity(entity.id)} title={`查看 ${entity.label} 的相关新闻`}>{entity.label}</button>)}{entities.length > 6 && <span>另有 {entities.length - 6} 个实体</span>}</div><details className="card-evidence"><summary>来源与证据</summary>{source && <><p>来源：{source.title}</p><a href={source.archiveUrl} target="_blank" rel="noreferrer">打开原始档案 ↗</a></>}<p><Link prefetch={false} href={`/news/${encodeURIComponent(event.newsId)}/`} onClick={(click) => reader.openNews(event.newsId, click)}>阅读完整来源与证据 →</Link></p></details></div><Link prefetch={false} className="result-link" href={`/news/${encodeURIComponent(event.newsId)}/`} onClick={(click) => reader.openNews(event.newsId, click)} aria-label={`阅读新闻：${event.title}`}>阅读 <span aria-hidden="true">→</span></Link></article>;
        })}</div>{pagination(newsPage)}</> : <div className="empty-result"><strong>{["week", "month"].includes(feed) ? "这个时间范围内没有新闻" : "没有找到匹配新闻"}</strong><p>{["week", "month"].includes(feed) ? `此范围按当前日期 ${today} 计算。档案仍可按最新新闻日期浏览。` : "试试更宽泛的关键词，或减少一个筛选条件。"}</p><button type="button" onClick={reset}>查看全部最新新闻</button></div>}
      </>}
      <div className="reading-history-controls"><span>已读状态仅保存在当前浏览器。</span>{confirmClear ? <><span>清除本机已读记录？</span><button type="button" onClick={() => { reader.clearReadingHistory(); setConfirmClear(false); }}>确认清除</button><button type="button" onClick={() => setConfirmClear(false)}>取消</button></> : <button type="button" onClick={() => setConfirmClear(true)}>清除已读记录</button>}</div>
    </section>
    <footer><span>历史经纬 · 从新闻找到知识连接</span><span><Link prefetch={false} href="/ontology/">知识分类</Link> · <Link prefetch={false} href="/graph/">探索关系</Link></span></footer>
  </main>;
}

function FilterSelect({ id, label, value, onChange, options, placeholder }: { id: string; label: string; value: string; onChange: (value: string) => void; options: Array<{ id: string; label: string }>; placeholder: string }) {
  return <label className="filter-field" htmlFor={id}><span>{label}</span><select id={id} value={value} onChange={(event) => onChange(event.target.value)}><option value="">{placeholder}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>;
}
// Shared by search results and the selected-news inspector. All class and enum
// names are read from the compiled ontology; spans remain quoted source text.
export function ActionAssessmentEvidence({ ontology, event, filter = {}, expanded = false }: { ontology: Ontology; event: Event; filter?: ActionFilter; expanded?: boolean }) {
  const assessment = event.actionAssessment;
  if (!assessment) return <small>历史版本未记录行动评估</small>;
  const matches = actionMatchReasons(ontology, event, filter);
  return <section className="action-assessment-evidence" aria-label="报道中的行动/变化">
    <p><strong>报道中的行动/变化</strong> · {actionAssessmentLabel(ontology, "statuses", assessment.status)}</p>
    <small>{actionAssessmentLabel(ontology, "reasonCodes", assessment.reasonCode)}；仅描述本条报道，不验证现实发生。</small>
    {matches.map((match) => <details key={`${match.conceptId}:${match.polarity}:${match.modality}`} open={expanded || undefined}>
      <summary>{match.label}{filter.conceptId ? `（${match.inherited ? "由下级归入" : "直接关联"}）` : ""} · {actionAssessmentLabel(ontology, "polarities", match.polarity)} · {actionAssessmentLabel(ontology, "modalities", match.modality)} · {match.evidence.length} 处证据</summary>
      {match.evidence.map((evidence: ActionAssignment["evidence"][number], index: number) => <div key={`${evidence.ruleId}:${evidence.predicate.start}:${index}`}>
        <p>原文范围：{evidence.scope.text}</p>
        <small>谓词：{evidence.predicate.text} · UTF-16 [{evidence.predicate.start}, {evidence.predicate.end}) · 规则 {evidence.ruleId}</small>
        {evidence.qualifiers.length ? <p>原文限定：{evidence.qualifiers.map((qualifier) => `${qualifier.text}（${actionAssessmentLabel(ontology, qualifier.kind === "polarity" ? "polarities" : "modalities", qualifier.value)}；${qualifier.start}–${qualifier.end}）`).join("、")}</p> : <p>此局部范围未命中限定词；这不构成事实核实。</p>}
      </div>)}
    </details>)}
    {assessment.review && <details open={expanded || undefined}><summary>查看不适用审查</summary><p>{assessment.review.reason}</p><p>原文范围：{assessment.review.evidence.text}</p><small>{assessment.review.reviewedAt} · UTF-16 [{assessment.review.evidence.start}, {assessment.review.evidence.end}) · 审查 {assessment.review.id}</small></details>}
  </section>;
}
