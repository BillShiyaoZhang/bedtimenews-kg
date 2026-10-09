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
import { ReportDescriptionDetails } from "./report-description-details";

type SearchMode = "keyword" | "filters";
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
const RESULT_LIMIT = 60;
const ENTITY_RESULT_LIMIT = 12;

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

type SubmittedSearch = { mode: "keyword"; query: string } | { mode: "filters"; filters: Filters } | null;

// Explicit allowlists keep stale or hand-edited links from throwing in strict
// filter helpers. Unknown URL parameters are preserved when writing navigation.
export function readExplorerLocation(search: string, ontology: Ontology) {
  const parameters = new URLSearchParams(search);
  const mode: SearchMode = parameters.get("mode") === "filters" ? "filters" : "keyword";
  const filters = { ...EMPTY_FILTERS };
  const invalidFilters: string[] = [];
  for (const key of Object.keys(filters) as (keyof Filters)[]) filters[key] = parameters.get(key) ?? "";
  const allow = (key: keyof Filters, ids: string[]) => {
    if (filters[key] && !ids.includes(filters[key])) {
      invalidFilters.push(key);
      filters[key] = "";
    }
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
  for (const key of ["fromYear", "toYear"] as const) if (filters[key] && !/^\d{4}$/u.test(filters[key])) {
    invalidFilters.push(key);
    filters[key] = "";
  }
  const query = parameters.get("q") ?? "";
  const submitted: SubmittedSearch = mode === "keyword"
    ? (query.trim() ? { mode, query: query.trim() } : null)
    : (parameters.get("submitted") === "1" ? { mode, filters } : null);
  return { mode, query, filters, submitted, invalidFilters };
}

export function explorerLocationSearch(current: string, mode: SearchMode, search: SubmittedSearch) {
  const parameters = new URLSearchParams(current);
  for (const key of ["mode", "q", "submitted", ...Object.keys(EMPTY_FILTERS)]) parameters.delete(key);
  if (mode === "filters") parameters.set("mode", mode);
  if (search?.mode === "keyword") parameters.set("q", search.query);
  if (search?.mode === "filters") {
    parameters.set("submitted", "1");
    for (const [key, value] of Object.entries(search.filters)) if (value) parameters.set(key, value);
  }
  const query = parameters.toString();
  return query ? `?${query}` : "";
}

function writeExplorerLocation(mode: SearchMode, search: SubmittedSearch) {
  const url = new URL(window.location.href);
  const next = explorerLocationSearch(url.search, mode, search);
  if (url.search === next) return;
  url.search = next;
  window.history.pushState({}, "", url);
  window.dispatchEvent(new window.Event(SEARCH_LOCATION_EVENT));
}

export function KGExplorer({ initialKG, initialOntology }: { initialKG: KnowledgeBase; initialOntology: Ontology }) {
  const locationSearch = useSyncExternalStore(subscribeToSearchLocation, getSearchLocation, getServerSearchLocation);
  return <KGExplorerView key={locationSearch} initialKG={initialKG} initialOntology={initialOntology} locationSearch={locationSearch} />;
}

function KGExplorerView({
  initialKG,
  initialOntology,
  locationSearch,
}: {
  initialKG: KnowledgeBase;
  initialOntology: Ontology;
  locationSearch: string;
}) {
  const initial = useMemo(() => readExplorerLocation(locationSearch, initialOntology), [locationSearch, initialOntology]);
  const [mode, setMode] = useState<SearchMode>(initial.mode);
  const [query, setQuery] = useState(initial.query);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [search, setSearch] = useState<SubmittedSearch>(initial.submitted);

  const entityById = useMemo(
    () => new Map(initialKG.entities.map((entity) => [entity.id, entity])),
    [initialKG.entities],
  );
  const sourceById = useMemo(
    () => new Map(initialKG.sources.map((source) => [source.id, source])),
    [initialKG.sources],
  );
  const eventTypeById = useMemo(
    () =>
      new Map(
        initialOntology.eventTypes.map((eventType) => [
          eventType.id,
          eventType,
        ]),
      ),
    [initialOntology.eventTypes],
  );
  const entityTypeById = useMemo(
    () =>
      new Map(
        initialOntology.entityTypes.map((entityType) => [
          entityType.id,
          entityType,
        ]),
      ),
    [initialOntology.entityTypes],
  );
  const entitiesByType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of initialKG.events) {
      for (const id of event.entityIds) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const options = (types: string[]) =>
      initialKG.entities
        .filter((entity) => types.includes(entity.type) && counts.has(entity.id))
        .sort(
          (left, right) =>
            (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0) ||
            left.label.localeCompare(right.label, "zh-CN"),
        );
    return {
      subjects: options(initialOntology.facets.find((facet) => facet.id === "subject")?.entityTypes ?? []),
      places: options(initialOntology.facets.find((facet) => facet.id === "place")?.entityTypes ?? []),
      objects: options(initialOntology.facets.find((facet) => facet.id === "named_object")?.entityTypes ?? []),
    };
  }, [initialKG.entities, initialKG.events, initialOntology.facets]);
  const topicOptions = useMemo(() => {
    const hierarchy = initialOntology.hierarchies.topic;
    const options: { id: string; label: string }[] = [];
    const visit = (parentId: string, depth: number) => {
      for (const node of hierarchy.nodes.filter((node) => node.primaryParentId === parentId)) {
        options.push({ id: node.id, label: `${"　".repeat(depth)}${node.label}${node.abstract ? "（含下级）" : ""}` });
        visit(node.id, depth + 1);
      }
    };
    visit(hierarchy.rootId, 0);
    return options;
  }, [initialOntology.hierarchies.topic]);
  const actionOptions = useMemo(() => actionFilterOptions(initialOntology, initialKG.events), [initialOntology, initialKG.events]);
  const searchableEvents = useMemo(
    () =>
      initialKG.events.map((event) => {
        const entities = event.entityIds
          .map((id) => entityById.get(id))
          .filter(Boolean) as Entity[];
        const source = sourceById.get(event.sourceIds[0]);
        return createEventSearchDocument({
          event,
          entities,
          source,
          eventType: eventTypeById.get(event.type),
          entityTypes: entities
            .map((entity) => entityTypeById.get(entity.type))
            .filter(Boolean),
        });
      }),
    [
      entityById,
      entityTypeById,
      eventTypeById,
      initialKG.events,
      sourceById,
    ],
  );
  const searchableEntities = useMemo(
    () =>
      initialKG.entities.map((entity) =>
        createEntitySearchDocument(
          entity,
          entityTypeById.get(entity.type),
        ),
      ),
    [entityTypeById, initialKG.entities],
  );

  const result = useMemo(() => {
    if (!search || (search.mode === "filters" && initial.invalidFilters.length)) {
      return {
        total: 0,
        events: [] as Event[],
        totalEntities: 0,
        entities: [] as Entity[],
      };
    }
    let matching = searchableEvents;
    let matchingEntities: Entity[] = [];
    if (search.mode === "keyword") {
      const terms = parseSearchQuery(search.query);
      matching = matching.filter((document) =>
        matchesSearchDocument(document, terms),
      );
      matchingEntities = searchableEntities
        .filter((document) => matchesSearchDocument(document, terms))
        .sort(
          (left, right) =>
            rankEntitySearchDocument(right, search.query) -
              rankEntitySearchDocument(left, search.query) ||
            (right.entity.identityResolution?.newsCount ?? right.entity.extraction?.eventCount ?? 0) -
              (left.entity.identityResolution?.newsCount ?? left.entity.extraction?.eventCount ?? 0) ||
            left.entity.label.localeCompare(right.entity.label, "zh-CN"),
        )
        .map(({ entity }) => entity);
    } else {
      const selected = search.filters;
      const selectedTopicIds = selected.topicId ? new Set(topicEntityIds(initialOntology, selected.topicId)) : null;
      matching = matching.filter(({ event }) => {
        if (selected.eventType && event.type !== selected.eventType) {
          return false;
        }
        for (const id of [
          selected.subjectId,
          selected.placeId,
          selected.objectId,
        ]) {
          if (id && !event.entityIds.includes(id)) return false;
        }
        if (selectedTopicIds && !event.entityIds.some((id: string) => selectedTopicIds.has(id))) return false;
        if (!eventMatchesAction(initialOntology, event, actionFilter(selected))) return false;
        if (!eventMatchesReportingForm(event, { status: selected.reportingFormStatus, conceptId: selected.reportingFormConceptId })) return false;
        if (!eventMatchesNumericObservation(event, { status: selected.numericStatus, comparison: selected.numericComparison })) return false;
        const year = Number(event.date.slice(0, 4));
        if (selected.fromYear && year < Number(selected.fromYear)) return false;
        if (selected.toYear && year > Number(selected.toYear)) return false;
        return true;
      });
      matchingEntities = [
        selected.subjectId,
        selected.placeId,
        selected.topicId,
        selected.objectId,
      ]
        .filter(Boolean)
        .map((id) => entityById.get(id))
        .filter(Boolean) as Entity[];
    }
    const ordered = matching
      .sort(
        (left, right) =>
          (search.mode === "keyword"
            ? rankEventSearchDocument(right, search.query) -
              rankEventSearchDocument(left, search.query)
            : 0) ||
          right.event.date.localeCompare(left.event.date) ||
          left.event.title.localeCompare(right.event.title, "zh-CN"),
      )
      .map(({ event }) => event)
    if (search.mode !== "keyword") {
      matchingEntities.sort(
        (left, right) =>
          (right.identityResolution?.newsCount ?? right.extraction?.eventCount ?? 0) -
            (left.identityResolution?.newsCount ?? left.extraction?.eventCount ?? 0) ||
          left.label.localeCompare(right.label, "zh-CN"),
      );
    }
    return {
      total: ordered.length,
      events: ordered.slice(0, RESULT_LIMIT),
      totalEntities: matchingEntities.length,
      entities: matchingEntities.slice(0, ENTITY_RESULT_LIMIT),
    };
  }, [entityById, search, searchableEntities, searchableEvents, initialOntology, initial.invalidFilters]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "keyword") {
      const normalized = query.trim();
      if (!normalized) return;
      setSearch({ mode, query: normalized });
      writeExplorerLocation(mode, { mode, query: normalized });
    } else {
      setSearch({ mode, filters: { ...filters } });
      writeExplorerLocation(mode, { mode, filters: { ...filters } });
    }
  };
  const switchMode = (nextMode: SearchMode) => {
    setMode(nextMode);
    setSearch(null);
    writeExplorerLocation(nextMode, null);
  };
  const updateFilter = (key: keyof Filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <main className="search-page">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="历史经纬首页">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>历史经纬</strong>
            <small>Bedtime News Knowledge Atlas</small>
          </span>
        </a>
        <a
          className="archive-link"
          href={initialKG.source.url}
          target="_blank"
          rel="noreferrer"
        >
          新闻原库 <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="search-hero" id="top">
        <div className="hero-copy">
          <span className="eyebrow">把新闻放回历史坐标</span>
          <h1>
            从一个词出发，
            <em>找到新闻之间的时间线索。</em>
          </h1>
          <p>
            每条新闻均可回到原始 Markdown 的精确片段。你可以直接搜索，也可以按事件类型、主体、地点与主题组合条件。
          </p>
        </div>

        <div className="search-panel">
          <div className="mode-tabs" role="tablist" aria-label="检索方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "keyword"}
              className={mode === "keyword" ? "active" : ""}
              onClick={() => switchMode("keyword")}
            >
              关键词搜索
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "filters"}
              className={mode === "filters" ? "active" : ""}
              onClick={() => switchMode("filters")}
            >
              按条件检索
            </button>
          </div>

          {initial.invalidFilters.length > 0 && mode === "filters" && <p className="invalid-filter-notice" role="status">链接包含此版本不支持的筛选条件，未扩大匹配范围。请重新选择条件并搜索，或清空条件。</p>}
          <form onSubmit={submit}>
            {mode === "keyword" ? (
              <div className="keyword-search">
                <label htmlFor="keyword">搜索新闻、主体、地点或主题</label>
                <div>
                  <span className="search-icon" aria-hidden="true" />
                  <input
                    id="keyword"
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="例如：人工智能、武汉、住房政策"
                    autoComplete="off"
                  />
                  <button type="submit">搜索</button>
                </div>
                <small>
                  支持中英文缩写、行政区简称和标点差异；多个关键词需同时匹配。
                </small>
              </div>
            ) : (
              <div className="filter-search">
                <FilterSelect
                  id="event-type"
                  label="报道领域"
                  value={filters.eventType}
                  onChange={(value) => updateFilter("eventType", value)}
                  options={initialOntology.eventTypes}
                  placeholder="全部兼容领域"
                />
                <EntitySelect
                  id="subject"
                  label="主体"
                  value={filters.subjectId}
                  onChange={(value) => updateFilter("subjectId", value)}
                  options={entitiesByType.subjects}
                  placeholder="全部人物与组织"
                />
                <EntitySelect
                  id="place"
                  label="地点"
                  value={filters.placeId}
                  onChange={(value) => updateFilter("placeId", value)}
                  options={entitiesByType.places}
                  placeholder="全部地点"
                />
                <FilterSelect
                  id="topic"
                  label="主题层级"
                  value={filters.topicId}
                  onChange={(value) => updateFilter("topicId", value)}
                  options={topicOptions}
                  placeholder="全部主题"
                />
                <EntitySelect
                  id="object"
                  label="对象"
                  value={filters.objectId}
                  onChange={(value) => updateFilter("objectId", value)}
                  options={entitiesByType.objects}
                  placeholder="设施、政策与文献"
                />
                <div className="year-range">
                  <span>时间</span>
                  <div>
                    <label>
                      <span className="sr-only">起始年份</span>
                      <input
                        inputMode="numeric"
                        pattern="[0-9]{4}"
                        value={filters.fromYear}
                        onChange={(event) =>
                          updateFilter(
                            "fromYear",
                            event.target.value.replace(/\D/gu, "").slice(0, 4),
                          )
                        }
                        placeholder="起始年份"
                      />
                    </label>
                    <i aria-hidden="true">—</i>
                    <label>
                      <span className="sr-only">结束年份</span>
                      <input
                        inputMode="numeric"
                        pattern="[0-9]{4}"
                        value={filters.toYear}
                        onChange={(event) =>
                          updateFilter(
                            "toYear",
                            event.target.value.replace(/\D/gu, "").slice(0, 4),
                          )
                        }
                        placeholder="结束年份"
                      />
                    </label>
                  </div>
                </div>
                <FilterSelect
                  id="action-concept"
                  label="报道中的行动/变化"
                  value={filters.actionConceptId}
                  onChange={(value) => updateFilter("actionConceptId", value)}
                  options={actionOptions}
                  placeholder="全部受支持类别"
                />
                <FilterSelect
                  id="action-status"
                  label="行动适用性评估"
                  value={filters.actionStatus}
                  onChange={(value) => updateFilter("actionStatus", value)}
                  options={initialOntology.actionAssessment?.statuses ?? []}
                  placeholder="全部评估状态"
                />
                <FilterSelect
                  id="action-polarity"
                  label="行动极性"
                  value={filters.actionPolarity}
                  onChange={(value) => updateFilter("actionPolarity", value)}
                  options={initialOntology.actionAssessment?.polarities ?? []}
                  placeholder="全部极性"
                />
                <FilterSelect
                  id="action-modality"
                  label="行动模态"
                  value={filters.actionModality}
                  onChange={(value) => updateFilter("actionModality", value)}
                  options={initialOntology.actionAssessment?.modalities ?? []}
                  placeholder="全部模态"
                />
                <small style={{ gridColumn: "1 / -1" }}>行动选项按全库独立新闻计数；类别、极性和模态必须由同一条分配同时满足。描述来自报道，不表示现实已经发生或得到独立证实。</small>
                <FilterSelect
                  id="reporting-form"
                  label="报道形式（经审查）"
                  value={filters.reportingFormConceptId}
                  onChange={(value) => updateFilter("reportingFormConceptId", value)}
                  options={initialOntology.reportingForm?.concepts.filter((entry) => entry.status === "active") ?? []}
                  placeholder="全部审查标签"
                />
                <FilterSelect
                  id="reporting-form-status"
                  label="报道形式审查状态"
                  value={filters.reportingFormStatus}
                  onChange={(value) => updateFilter("reportingFormStatus", value)}
                  options={[
                    { id: "applicable", label: "已有审查标签" },
                    { id: "undetermined", label: "尚未确定" },
                    { id: "not_applicable", label: "经审查不适用" },
                  ]}
                  placeholder="全部状态"
                />
                <FilterSelect
                  id="numeric-status"
                  label="报道中的数值描述"
                  value={filters.numericStatus}
                  onChange={(value) => updateFilter("numericStatus", value)}
                  options={[
                    { id: "applicable", label: "已有受支持描述" },
                    { id: "undetermined", label: "尚未确定" },
                  ]}
                  placeholder="全部状态"
                />
                <FilterSelect
                  id="numeric-comparison"
                  label="数值比较方式"
                  value={filters.numericComparison}
                  onChange={(value) => updateFilter("numericComparison", value)}
                  options={[
                    { id: "year_over_year", label: "同比" },
                    { id: "month_over_month", label: "环比" },
                  ]}
                  placeholder="全部比较方式"
                />
                <small className="report-description-filter-note">报道形式只来自对本条片段的明确审查；词表不表示已有分类覆盖。数值状态与比较方式须由同一条数值描述满足；尚未确定不等于原文没有数值。</small>
                <div className="filter-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setFilters({ ...EMPTY_FILTERS });
                      setSearch(null);
                      writeExplorerLocation("filters", null);
                    }}
                  >
                    清空条件
                  </button>
                  <button type="submit">查找新闻</button>
                </div>
              </div>
            )}
          </form>
        </div>
        <dl className="data-summary" aria-label="知识库规模">
          <div>
            <dt>独立新闻</dt>
            <dd>{initialKG.events.length.toLocaleString("zh-CN")}</dd>
          </div>
          <div>
            <dt>语义实体</dt>
            <dd>{initialKG.entities.length.toLocaleString("zh-CN")}</dd>
          </div>
          <div>
            <dt>原文来源</dt>
            <dd>{initialKG.sources.length.toLocaleString("zh-CN")}</dd>
          </div>
        </dl>
      </section>

      {search ? (
        <SearchResults
          ontology={initialOntology}
          selectedTopicId={search.mode === "filters" ? search.filters.topicId : ""}
          selectedActionFilter={search.mode === "filters" ? actionFilter(search.filters) : {}}
          total={result.total}
          events={result.events}
          totalEntities={result.totalEntities}
          entities={result.entities}
          entityById={entityById}
          sourceById={sourceById}
          eventTypeById={eventTypeById}
          entityTypeById={entityTypeById}
        />
      ) : null}

      <footer>
        <span>
          <Link href="/ontology">浏览 Ontology {initialOntology.version}</Link>
          {" · "}
          <Link href="/graph">浏览知识图谱</Link>
        </span>
        <span>每条结果均保留原文证据链接</span>
      </footer>
    </main>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ id: string; label: string }>;
  placeholder: string;
}) {
  return (
    <label className="filter-field" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function EntitySelect({
  options,
  ...props
}: Omit<Parameters<typeof FilterSelect>[0], "options"> & {
  options: Entity[];
}) {
  return <FilterSelect {...props} options={options} />;
}

function SearchResults({
  ontology,
  selectedTopicId,
  selectedActionFilter,
  total,
  events,
  totalEntities,
  entities,
  entityById,
  sourceById,
  eventTypeById,
  entityTypeById,
}: {
  ontology: Ontology;
  selectedTopicId: string;
  selectedActionFilter: ActionFilter;
  total: number;
  events: Event[];
  totalEntities: number;
  entities: Entity[];
  entityById: Map<string, Entity>;
  sourceById: Map<string, KnowledgeBase["sources"][number]>;
  eventTypeById: Map<string, Ontology["eventTypes"][number]>;
  entityTypeById: Map<string, Ontology["entityTypes"][number]>;
}) {
  return (
    <section className="results-section" aria-live="polite">
      {entities.length ? (
        <div className="entity-result-block">
          <div className="entity-result-heading">
            <div>
              <span className="eyebrow">匹配实体</span>
              <h2>
                找到 <strong>{totalEntities.toLocaleString("zh-CN")}</strong>{" "}
                个实体
              </h2>
            </div>
            <p>进入实体页查看相关新闻时间线与知识图谱。</p>
          </div>
          <div className="entity-result-grid">
            {entities.map((entity) => {
              const type = entityTypeById.get(entity.type);
              return (
                <Link
                  className="entity-result-card"
                  href={{ pathname: "/graph", query: { entity: entity.id } }}
                  key={entity.id}
                >
                  <span
                    style={{ "--entity-color": type?.color } as CSSProperties}
                  >
                    {type?.label ?? entity.type}
                  </span>
                  <strong>{entity.label}</strong>
                  {entity.identityResolution && <small>经审查的新闻级身份</small>}
                  <small>
                    关联{" "}
                    {(entity.identityResolution?.newsCount ?? entity.extraction?.eventCount ?? 0).toLocaleString(
                      "zh-CN",
                    )}{" "}
                    条新闻
                  </small>
                  <i aria-hidden="true">查看新闻与图谱 →</i>
                </Link>
              );
            })}
          </div>
          {totalEntities > ENTITY_RESULT_LIMIT ? (
            <p className="entity-result-more">
              当前显示关联新闻最多的 {ENTITY_RESULT_LIMIT} 个实体。
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="results-heading">
        <div>
          <span className="eyebrow">检索结果</span>
          <h2>
            找到 <strong>{total.toLocaleString("zh-CN")}</strong> 条新闻
          </h2>
        </div>
        {total > RESULT_LIMIT ? (
          <p>按时间显示最近 {RESULT_LIMIT} 条，请增加条件缩小范围。</p>
        ) : (
          <p>按新闻日期从近到远排列。</p>
        )}
      </div>
      {events.length ? (
        <div className="result-list">
          {events.map((event) => {
            const eventType = eventTypeById.get(event.type);
            const entities = event.entityIds
              .map((id) => entityById.get(id))
              .filter(Boolean) as Entity[];
            const source = sourceById.get(event.sourceIds[0]);
            return (
              <article className="result-card" key={event.id}>
                <div className="result-date">
                  <strong>{event.date.slice(0, 4)}</strong>
                  <span>{formatEventDate(event)}</span>
                </div>
                <div className="result-content">
                  <div className="result-meta">
                    <span style={{ "--type-color": eventType?.color } as CSSProperties}>
                      {eventType?.label ?? event.type}
                    </span>
                    {source ? <i>{source.kind}</i> : null}
                  </div>
                  <h3>{event.title}</h3>
                  {selectedTopicId && <small className="topic-match-reason">主题命中：{topicMatchReason(ontology, event, selectedTopicId).map((match) => `${match.label}（${match.inherited ? "由下级归入" : "直接关联"}）`).join("、")}</small>}
                  <p>{event.summary || "原文未提供摘要，请查看出处。"}</p>
                  <ActionAssessmentEvidence ontology={ontology} event={event} filter={selectedActionFilter} />
                  <ReportDescriptionDetails ontology={ontology} event={event} />
                  {!!event.identityAssignments?.length && <small>含经审查的新闻级实体归属；原始抽取与证据单独保留</small>}
                  <div className="entity-tags">
                    {entities.slice(0, 8).map((entity) => (
                      <Link
                        href={{
                          pathname: "/graph",
                          query: { entity: entity.id },
                        }}
                        key={entity.id}
                        data-type={entity.type}
                        title={`查看“${entity.label}”的相关新闻与知识图谱`}
                      >
                        {entity.label}
                      </Link>
                    ))}
                    {entities.length > 8 ? (
                      <span>+{entities.length - 8}</span>
                    ) : null}
                  </div>
                </div>
                {source ? (
                  <a
                    className="result-link"
                    href={source.archiveUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`阅读原文：${source.title}`}
                  >
                    原文 <span aria-hidden="true">↗</span>
                  </a>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-result">
          <strong>没有找到匹配新闻</strong>
          <p>试试更宽泛的关键词，或减少一个筛选条件。</p>
        </div>
      )}
    </section>
  );
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
