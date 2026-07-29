"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState, type CSSProperties } from "react";
import {
  formatEventDate,
  type Entity,
  type Event,
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

type SearchMode = "keyword" | "filters";
type Filters = {
  eventType: string;
  subjectId: string;
  placeId: string;
  topicId: string;
  objectId: string;
  fromYear: string;
  toYear: string;
};

const EMPTY_FILTERS: Filters = {
  eventType: "",
  subjectId: "",
  placeId: "",
  topicId: "",
  objectId: "",
  fromYear: "",
  toYear: "",
};
const RESULT_LIMIT = 60;
const ENTITY_RESULT_LIMIT = 12;

export function KGExplorer({
  initialKG,
  initialOntology,
}: {
  initialKG: KnowledgeBase;
  initialOntology: Ontology;
}) {
  const [mode, setMode] = useState<SearchMode>("keyword");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [search, setSearch] = useState<
    | { mode: "keyword"; query: string }
    | { mode: "filters"; filters: Filters }
    | null
  >(null);

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
      subjects: options(["person", "organization"]),
      places: options(["place"]),
      topics: options(["topic"]),
      objects: options(["facility", "policy", "document"]),
    };
  }, [initialKG.entities, initialKG.events]);
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
    if (!search) {
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
            (right.entity.extraction?.eventCount ?? 0) -
              (left.entity.extraction?.eventCount ?? 0) ||
            left.entity.label.localeCompare(right.entity.label, "zh-CN"),
        )
        .map(({ entity }) => entity);
    } else {
      const selected = search.filters;
      matching = matching.filter(({ event }) => {
        if (selected.eventType && event.type !== selected.eventType) {
          return false;
        }
        for (const id of [
          selected.subjectId,
          selected.placeId,
          selected.topicId,
          selected.objectId,
        ]) {
          if (id && !event.entityIds.includes(id)) return false;
        }
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
          (right.extraction?.eventCount ?? 0) -
            (left.extraction?.eventCount ?? 0) ||
          left.label.localeCompare(right.label, "zh-CN"),
      );
    }
    return {
      total: ordered.length,
      events: ordered.slice(0, RESULT_LIMIT),
      totalEntities: matchingEntities.length,
      entities: matchingEntities.slice(0, ENTITY_RESULT_LIMIT),
    };
  }, [entityById, search, searchableEntities, searchableEvents]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "keyword") {
      const normalized = query.trim();
      if (!normalized) return;
      setSearch({ mode, query: normalized });
    } else {
      setSearch({ mode, filters: { ...filters } });
    }
  };
  const switchMode = (nextMode: SearchMode) => {
    setMode(nextMode);
    setSearch(null);
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
                  label="事件"
                  value={filters.eventType}
                  onChange={(value) => updateFilter("eventType", value)}
                  options={initialOntology.eventTypes}
                  placeholder="全部事件类型"
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
                <EntitySelect
                  id="topic"
                  label="主题"
                  value={filters.topicId}
                  onChange={(value) => updateFilter("topicId", value)}
                  options={entitiesByType.topics}
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
                <div className="filter-actions">
                  <button
                    type="button"
                    onClick={() => setFilters(EMPTY_FILTERS)}
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
  total,
  events,
  totalEntities,
  entities,
  entityById,
  sourceById,
  eventTypeById,
  entityTypeById,
}: {
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
                  <small>
                    关联{" "}
                    {(entity.extraction?.eventCount ?? 0).toLocaleString(
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
                  <p>{event.summary || "原文未提供摘要，请查看出处。"}</p>
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
