"use client";

import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { KnowledgeGraphCanvas } from "./knowledge-graph-canvas";
import {
  downloadJson,
  formatEventDate,
  getEntityEvents,
  getEventPath,
  getNeighborRelations,
  relationLabel,
  validateKnowledgeBase,
  type Event,
  type KnowledgeBase,
  type Ontology,
  type Relation,
  type RelationType,
} from "../lib/kg";

type View = "explore" | "graph" | "maintain";
type Period = "all" | "before-2000" | "2000-2014" | "after-2015";
type MaintenanceMode = "ontology" | "events" | "relations";

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: "all", label: "全部年代" },
  { id: "before-2000", label: "2000 年以前" },
  { id: "2000-2014", label: "2000—2014" },
  { id: "after-2015", label: "2015 年以后" },
];

const STORAGE_KEY = "bedtimenews-kg-workspace-v1";

export function KGExplorer({
  initialKG,
  initialOntology,
}: {
  initialKG: KnowledgeBase;
  initialOntology: Ontology;
}) {
  const [view, setView] = useState<View>("explore");
  const [kg, setKG] = useState<KnowledgeBase>(initialKG);
  const [ontology, setOntology] = useState<Ontology>(initialOntology);
  const [selectedEntityId, setSelectedEntityId] = useState(
    "concept-yangtze-rail",
  );
  const [selectedEventId, setSelectedEventId] = useState(
    "event-2020-yangtze-company",
  );
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [period, setPeriod] = useState<Period>("all");
  const [eventTypeFilter, setEventTypeFilter] = useState<string[]>([]);
  const [maintenanceMode, setMaintenanceMode] =
    useState<MaintenanceMode>("ontology");
  const [selectedOntologyGroup, setSelectedOntologyGroup] = useState<
    "entityTypes" | "eventTypes" | "relationTypes"
  >("entityTypes");
  const [selectedOntologyId, setSelectedOntologyId] = useState("person");
  const [selectedRelationId, setSelectedRelationId] = useState(
    initialKG.eventRelations[0]?.id ?? "",
  );
  const [toast, setToast] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as {
            ontology?: Ontology;
            kg?: KnowledgeBase;
          };
          if (parsed.ontology && parsed.kg) {
            setOntology(parsed.ontology);
            setKG(parsed.kg);
          }
        }
        const hash = new URLSearchParams(window.location.hash.slice(1));
        const entityId = hash.get("entity");
        const eventId = hash.get("event");
        if (
          entityId &&
          initialKG.entities.some((entity) => entity.id === entityId)
        ) {
          setSelectedEntityId(entityId);
        }
        if (
          eventId &&
          initialKG.events.some((event) => event.id === eventId)
        ) {
          setSelectedEventId(eventId);
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [initialKG]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ontology, kg }));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [kg, ontology]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("entity", selectedEntityId);
    params.set("event", selectedEventId);
    window.history.replaceState(null, "", `#${params.toString()}`);
  }, [selectedEntityId, selectedEventId]);

  useEffect(() => {
    if (!toast) return;
    const handle = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(handle);
  }, [toast]);

  const entityById = useMemo(
    () => new Map(kg.entities.map((entity) => [entity.id, entity])),
    [kg.entities],
  );
  const eventById = useMemo(
    () => new Map(kg.events.map((event) => [event.id, event])),
    [kg.events],
  );
  const sourceById = useMemo(
    () => new Map(kg.sources.map((source) => [source.id, source])),
    [kg.sources],
  );
  const selectedEntity = entityById.get(selectedEntityId) ?? kg.entities[0];
  const selectedEvent = eventById.get(selectedEventId) ?? kg.events[0];
  const entityEvents = selectedEntity
    ? getEntityEvents(kg, selectedEntity.id)
    : [];
  const visibleEvents = entityEvents.filter((event) => {
    const year = Number(event.date.slice(0, 4));
    const inPeriod =
      period === "all" ||
      (period === "before-2000" && year < 2000) ||
      (period === "2000-2014" && year >= 2000 && year <= 2014) ||
      (period === "after-2015" && year >= 2015);
    const typeMatch =
      eventTypeFilter.length === 0 || eventTypeFilter.includes(event.type);
    return inPeriod && typeMatch;
  });
  const selectedRelations = selectedEvent
    ? getNeighborRelations(kg, selectedEvent.id)
    : [];
  const validationIssues = validateKnowledgeBase(kg, ontology);
  const errorCount = validationIssues.filter(
    (issue) => issue.level === "error",
  ).length;
  const warningCount = validationIssues.length - errorCount;

  const searchResults = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return { entities: [], events: [] };
    const entities = kg.entities
      .filter((entity) =>
        [entity.label, ...entity.aliases, entity.description]
          .join(" ")
          .toLocaleLowerCase("zh-CN")
          .includes(needle),
      )
      .slice(0, 5);
    const events = kg.events
      .filter((event) =>
        [event.title, event.summary, event.significance]
          .join(" ")
          .toLocaleLowerCase("zh-CN")
          .includes(needle),
      )
      .slice(0, 4);
    return { entities, events };
  }, [kg.entities, kg.events, query]);

  const selectEntity = (entityId: string) => {
    setSelectedEntityId(entityId);
    const events = getEntityEvents(kg, entityId);
    if (events.length && !events.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(events.at(-1)?.id ?? events[0].id);
    }
    setSearchOpen(false);
  };

  const selectEvent = (eventId: string) => {
    const event = eventById.get(eventId);
    if (!event) return;
    setSelectedEventId(eventId);
    if (!event.entityIds.includes(selectedEntityId) && event.entityIds[0]) {
      setSelectedEntityId(event.entityIds[0]);
    }
    setSearchOpen(false);
  };

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    if (searchResults.entities[0]) {
      selectEntity(searchResults.entities[0].id);
    } else if (searchResults.events[0]) {
      selectEvent(searchResults.events[0].id);
    }
  };

  const toggleEventType = (typeId: string) => {
    setEventTypeFilter((current) =>
      current.includes(typeId)
        ? current.filter((id) => id !== typeId)
        : [...current, typeId],
    );
  };

  const saveSnapshot = () => {
    downloadJson("bedtimenews-kg-workspace.json", { ontology, kg });
    setToast("工作区快照已导出，可提交回仓库");
  };

  const restoreSnapshot = () => {
    setOntology(initialOntology);
    setKG(initialKG);
    localStorage.removeItem(STORAGE_KEY);
    setToast("已恢复仓库内置版本");
  };

  const importSnapshot = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as {
        ontology?: Ontology;
        kg?: KnowledgeBase;
      };
      if (!parsed.ontology || !parsed.kg) {
        throw new Error("missing root keys");
      }
      setOntology(parsed.ontology);
      setKG(parsed.kg);
      setToast("工作区已导入，并完成实时校验");
    } catch {
      setToast("导入失败：请选择由本工具导出的 JSON 快照");
    } finally {
      event.target.value = "";
    }
  };

  return (
    <main className="app-shell">
      <header className="site-header">
        <a
          className="brand"
          href="#top"
          aria-label="历史经纬首页"
          onClick={() => setView("explore")}
        >
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
        <nav className="main-nav" aria-label="主要导航">
          {[
            ["explore", "事件检索"],
            ["graph", "关系图谱"],
            ["maintain", "维护工作台"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => setView(id as View)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <a
            className="source-link"
            href={kg.source.url}
            target="_blank"
            rel="noreferrer"
          >
            新闻原库 <span aria-hidden="true">↗</span>
          </a>
          <button className="export-button" onClick={saveSnapshot}>
            导出工作区
          </button>
        </div>
      </header>

      {view !== "maintain" ? (
        <section className="search-band" aria-label="全库检索">
          <div className="search-intro">
            <span className="eyebrow">从实体进入历史</span>
            <h1>
              一条新闻，
              <em>放回时间里看。</em>
            </h1>
            <p>
              检索人物、组织、地点与议题，沿证据链查看事件如何承接、回应与转折。
            </p>
          </div>
          <div className="search-area">
            <form className="global-search" onSubmit={onSearch}>
              <label htmlFor="kg-search" className="sr-only">
                搜索实体或事件
              </label>
              <span className="search-glyph" aria-hidden="true" />
              <input
                id="kg-search"
                value={query}
                autoComplete="off"
                placeholder="搜索实体、别名或事件，例如“沿江高铁”"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSearchOpen(false);
                }}
              />
              <button type="submit">检索</button>
            </form>
            {searchOpen && query.trim() ? (
              <div className="search-results" role="listbox">
                {searchResults.entities.length ? (
                  <div>
                    <span className="result-group-label">实体</span>
                    {searchResults.entities.map((entity) => (
                      <button
                        role="option"
                        aria-selected={entity.id === selectedEntityId}
                        key={entity.id}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectEntity(entity.id)}
                      >
                        <span
                          className="result-type-dot"
                          style={{
                            background:
                              ontology.entityTypes.find(
                                (type) => type.id === entity.type,
                              )?.color ?? "#777",
                          }}
                        />
                        <strong>{entity.label}</strong>
                        <small>
                          {
                            ontology.entityTypes.find(
                              (type) => type.id === entity.type,
                            )?.label
                          }
                          {entity.aliases[0] ? ` · ${entity.aliases[0]}` : ""}
                        </small>
                      </button>
                    ))}
                  </div>
                ) : null}
                {searchResults.events.length ? (
                  <div>
                    <span className="result-group-label">事件</span>
                    {searchResults.events.map((event) => (
                      <button
                        role="option"
                        aria-selected={event.id === selectedEventId}
                        key={event.id}
                        onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
                        onClick={() => selectEvent(event.id)}
                      >
                        <span className="result-year">
                          {event.date.slice(0, 4)}
                        </span>
                        <strong>{event.title}</strong>
                      </button>
                    ))}
                  </div>
                ) : null}
                {!searchResults.entities.length &&
                !searchResults.events.length ? (
                  <p className="empty-search">
                    暂无匹配。可在维护工作台补充实体别名。
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="suggestion-row">
              <span>试试</span>
              {["沿江铁路", "能源安全", "合成氨产业", "武汉"].map(
                (suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => {
                      setQuery(suggestion);
                      const entity = kg.entities.find(
                        (candidate) =>
                          candidate.label === suggestion ||
                          candidate.aliases.includes(suggestion),
                      );
                      if (entity) selectEntity(entity.id);
                    }}
                  >
                    {suggestion}
                  </button>
                ),
              )}
            </div>
          </div>
        </section>
      ) : null}

      {view === "explore" && selectedEntity && selectedEvent ? (
        <ExploreView
          kg={kg}
          ontology={ontology}
          selectedEntity={selectedEntity}
          selectedEvent={selectedEvent}
          visibleEvents={visibleEvents}
          period={period}
          eventTypeFilter={eventTypeFilter}
          selectedRelations={selectedRelations}
          sourceById={sourceById}
          eventById={eventById}
          onSelectEvent={selectEvent}
          onSetPeriod={setPeriod}
          onToggleType={toggleEventType}
          onOpenGraph={() => setView("graph")}
        />
      ) : null}

      {view === "graph" && selectedEntity && selectedEvent ? (
        <GraphView
          kg={kg}
          ontology={ontology}
          selectedEntityId={selectedEntity.id}
          selectedEventId={selectedEvent.id}
          onSelectEntity={selectEntity}
          onSelectEvent={selectEvent}
          onOpenTimeline={() => setView("explore")}
        />
      ) : null}

      {view === "maintain" ? (
        <MaintenanceView
          kg={kg}
          ontology={ontology}
          issues={validationIssues}
          errorCount={errorCount}
          warningCount={warningCount}
          mode={maintenanceMode}
          selectedOntologyGroup={selectedOntologyGroup}
          selectedOntologyId={selectedOntologyId}
          selectedEventId={selectedEventId}
          selectedRelationId={selectedRelationId}
          onSetMode={setMaintenanceMode}
          onSetOntologyGroup={setSelectedOntologyGroup}
          onSetOntologyId={setSelectedOntologyId}
          onSetEventId={setSelectedEventId}
          onSetRelationId={setSelectedRelationId}
          onSetOntology={setOntology}
          onSetKG={setKG}
          onExport={saveSnapshot}
          onRestore={restoreSnapshot}
          onImport={() => importRef.current?.click()}
        />
      ) : null}

      <input
        ref={importRef}
        className="sr-only"
        type="file"
        accept="application/json,.json"
        onChange={importSnapshot}
      />
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
      <footer className="site-footer">
        <p>
          数据由机器提取与人工校订共同生成。关系是可审查的解释，不等同于事实因果。
        </p>
        <span>
          Schema {kg.schemaVersion} · {kg.entities.length} 实体 ·{" "}
          {kg.events.length} 事件 · {kg.eventRelations.length} 历史关联
        </span>
      </footer>
    </main>
  );
}

function ExploreView({
  kg,
  ontology,
  selectedEntity,
  selectedEvent,
  visibleEvents,
  period,
  eventTypeFilter,
  selectedRelations,
  sourceById,
  eventById,
  onSelectEvent,
  onSetPeriod,
  onToggleType,
  onOpenGraph,
}: {
  kg: KnowledgeBase;
  ontology: Ontology;
  selectedEntity: KnowledgeBase["entities"][number];
  selectedEvent: Event;
  visibleEvents: Event[];
  period: Period;
  eventTypeFilter: string[];
  selectedRelations: Relation[];
  sourceById: Map<string, KnowledgeBase["sources"][number]>;
  eventById: Map<string, Event>;
  onSelectEvent: (id: string) => void;
  onSetPeriod: (period: Period) => void;
  onToggleType: (id: string) => void;
  onOpenGraph: () => void;
}) {
  const entityType = ontology.entityTypes.find(
    (type) => type.id === selectedEntity.type,
  );
  const firstEvent = getEntityEvents(kg, selectedEntity.id)[0];
  const path = firstEvent
    ? getEventPath(kg, firstEvent.id, selectedEvent.id)
    : [];

  return (
    <section className="workspace" aria-label="事件时间线">
      <aside className="entity-panel">
        <div className="panel-kicker">当前实体</div>
        <div className="entity-title-row">
          <span
            className="entity-symbol"
            style={{ background: entityType?.color }}
            aria-hidden="true"
          >
            {selectedEntity.label.slice(0, 1)}
          </span>
          <div>
            <h2>{selectedEntity.label}</h2>
            <span>{entityType?.label}</span>
          </div>
        </div>
        <p className="entity-description">{selectedEntity.description}</p>
        {selectedEntity.aliases.length ? (
          <div className="alias-block">
            <span>别名</span>
            <p>{selectedEntity.aliases.join(" · ")}</p>
          </div>
        ) : null}
        <dl className="entity-stats">
          <div>
            <dt>相关事件</dt>
            <dd>{getEntityEvents(kg, selectedEntity.id).length}</dd>
          </div>
          <div>
            <dt>时间跨度</dt>
            <dd>
              {getEntityEvents(kg, selectedEntity.id)[0]?.date.slice(0, 4)}—
              {getEntityEvents(kg, selectedEntity.id)
                .at(-1)
                ?.date.slice(0, 4)}
            </dd>
          </div>
        </dl>
        <button className="graph-jump" onClick={onOpenGraph}>
          <span className="mini-network" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          查看实体关系图
          <b aria-hidden="true">→</b>
        </button>
        <div className="provenance-note">
          <strong>
            <span aria-hidden="true">✓</span> 可追溯数据
          </strong>
          <p>每个事件与关系都保留原文路径和判断依据。</p>
        </div>
      </aside>

      <div className="timeline-panel">
        <div className="timeline-toolbar">
          <div>
            <span className="panel-kicker">事件时间线</span>
            <h2>{visibleEvents.length} 个节点</h2>
          </div>
          <select
            aria-label="选择时间范围"
            value={period}
            onChange={(event) => onSetPeriod(event.target.value as Period)}
          >
            {PERIODS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="type-filters" aria-label="事件类型筛选">
          {ontology.eventTypes.map((type) => {
            const active =
              eventTypeFilter.length === 0 ||
              eventTypeFilter.includes(type.id);
            return (
              <button
                key={type.id}
                className={active ? "active" : ""}
                onClick={() => onToggleType(type.id)}
                aria-pressed={eventTypeFilter.includes(type.id)}
              >
                <i style={{ background: type.color }} />
                {type.label}
              </button>
            );
          })}
        </div>
        <div className="timeline-list">
          {visibleEvents.map((event) => {
            const type = ontology.eventTypes.find(
              (candidate) => candidate.id === event.type,
            );
            const active = event.id === selectedEvent.id;
            return (
              <article
                key={event.id}
                className={`timeline-event ${active ? "selected" : ""}`}
              >
                <button
                  className="timeline-event-button"
                  onClick={() => onSelectEvent(event.id)}
                  aria-current={active ? "true" : undefined}
                >
                  <time dateTime={event.date}>
                    <strong>{event.date.slice(0, 4)}</strong>
                    <span>{formatEventDate(event).replace(event.date.slice(0, 4), "")}</span>
                  </time>
                  <span
                    className="timeline-node"
                    style={{ borderColor: type?.color }}
                    aria-hidden="true"
                  >
                    <i style={{ background: type?.color }} />
                  </span>
                  <span className="event-card-copy">
                    <span className="event-meta">
                      <i style={{ background: type?.color }} />
                      {type?.label}
                    </span>
                    <strong>{event.title}</strong>
                    <span>{event.summary}</span>
                    <span className="entity-chips">
                      {event.entityIds.slice(0, 4).map((entityId) => (
                        <i key={entityId}>
                          {kg.entities.find((entity) => entity.id === entityId)
                            ?.label ?? entityId}
                        </i>
                      ))}
                    </span>
                  </span>
                  <span className="event-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
              </article>
            );
          })}
          {!visibleEvents.length ? (
            <div className="timeline-empty">
              当前筛选下没有事件。清除类型筛选或切换年代。
            </div>
          ) : null}
        </div>
      </div>

      <aside className="context-panel">
        <div className="context-header">
          <span className="panel-kicker">事件上下文</span>
          <span className="confidence-pill">
            关系 {selectedRelations.length}
          </span>
        </div>
        <h2>{selectedEvent.title}</h2>
        <time dateTime={selectedEvent.date}>
          {formatEventDate(selectedEvent)}
        </time>
        <p className="context-summary">{selectedEvent.summary}</p>
        <div className="significance-card">
          <span>为何重要</span>
          <p>{selectedEvent.significance}</p>
        </div>

        <div className="relation-section">
          <h3>前后关联</h3>
          {selectedRelations.map((relation) => {
            const otherId =
              relation.from === selectedEvent.id
                ? relation.to
                : relation.from;
            const other = eventById.get(otherId);
            if (!other) return null;
            return (
              <button
                key={relation.id}
                onClick={() => onSelectEvent(other.id)}
                className="relation-card"
              >
                <span>
                  {relation.from === selectedEvent.id ? "之后" : "之前"} ·{" "}
                  {relationLabel(ontology, relation.type)}
                </span>
                <strong>{other.title}</strong>
                <small>{other.date.slice(0, 4)}</small>
              </button>
            );
          })}
        </div>

        {path.length ? (
          <div className="path-card">
            <span>从最早节点到此处</span>
            <ol>
              {path.map((relation) => (
                <li key={relation.id}>
                  <i />
                  {relationLabel(ontology, relation.type)}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <div className="evidence-section">
          <h3>证据出处</h3>
          {selectedEvent.sourceIds.map((sourceId) => {
            const source = sourceById.get(sourceId);
            if (!source) return null;
            return (
              <div key={source.id} className="source-card">
                <span>睡前消息原文</span>
                <strong>{source.title}</strong>
                <div>
                  <a href={source.archiveUrl} target="_blank" rel="noreferrer">
                    阅读存档 ↗
                  </a>
                  <a
                    href={source.repositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看 Markdown ↗
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    </section>
  );
}

function GraphView({
  kg,
  ontology,
  selectedEntityId,
  selectedEventId,
  onSelectEntity,
  onSelectEvent,
  onOpenTimeline,
}: {
  kg: KnowledgeBase;
  ontology: Ontology;
  selectedEntityId: string;
  selectedEventId: string;
  onSelectEntity: (id: string) => void;
  onSelectEvent: (id: string) => void;
  onOpenTimeline: () => void;
}) {
  const entity = kg.entities.find((item) => item.id === selectedEntityId);
  const event = kg.events.find((item) => item.id === selectedEventId);
  const relations = event ? getNeighborRelations(kg, event.id) : [];

  return (
    <section className="graph-workspace">
      <div className="graph-heading">
        <div>
          <span className="eyebrow">关系图谱</span>
          <h2>
            以“{entity?.label}”为中心，
            <em>查看历史如何连接。</em>
          </h2>
        </div>
        <div className="graph-controls">
          <span>点击节点可切换焦点</span>
          <button onClick={onOpenTimeline}>返回时间线</button>
        </div>
      </div>
      <div className="graph-layout">
        <KnowledgeGraphCanvas
          kg={kg}
          ontology={ontology}
          selectedEntityId={selectedEntityId}
          selectedEventId={selectedEventId}
          onSelectEntity={onSelectEntity}
          onSelectEvent={onSelectEvent}
        />
        <aside className="graph-inspector">
          <span className="panel-kicker">节点检查器</span>
          <h3>{event?.title}</h3>
          {event ? (
            <>
              <time>{formatEventDate(event)}</time>
              <p>{event.summary}</p>
              <div className="inspector-entities">
                <span>参与实体</span>
                {event.entityIds.map((entityId) => {
                  const item = kg.entities.find(
                    (candidate) => candidate.id === entityId,
                  );
                  return (
                    <button
                      key={entityId}
                      onClick={() => onSelectEntity(entityId)}
                    >
                      {item?.label ?? entityId}
                    </button>
                  );
                })}
              </div>
              <div className="inspector-relations">
                <span>关联判断</span>
                {relations.map((relation) => (
                  <button
                    key={relation.id}
                    onClick={() =>
                      onSelectEvent(
                        relation.from === event.id
                          ? relation.to
                          : relation.from,
                      )
                    }
                  >
                    <strong>
                      {relationLabel(ontology, relation.type)}
                      <i>{Math.round((relation.confidence ?? 1) * 100)}%</i>
                    </strong>
                    <small>{relation.evidence}</small>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function MaintenanceView({
  kg,
  ontology,
  issues,
  errorCount,
  warningCount,
  mode,
  selectedOntologyGroup,
  selectedOntologyId,
  selectedEventId,
  selectedRelationId,
  onSetMode,
  onSetOntologyGroup,
  onSetOntologyId,
  onSetEventId,
  onSetRelationId,
  onSetOntology,
  onSetKG,
  onExport,
  onRestore,
  onImport,
}: {
  kg: KnowledgeBase;
  ontology: Ontology;
  issues: ReturnType<typeof validateKnowledgeBase>;
  errorCount: number;
  warningCount: number;
  mode: MaintenanceMode;
  selectedOntologyGroup: "entityTypes" | "eventTypes" | "relationTypes";
  selectedOntologyId: string;
  selectedEventId: string;
  selectedRelationId: string;
  onSetMode: (mode: MaintenanceMode) => void;
  onSetOntologyGroup: (
    group: "entityTypes" | "eventTypes" | "relationTypes",
  ) => void;
  onSetOntologyId: (id: string) => void;
  onSetEventId: (id: string) => void;
  onSetRelationId: (id: string) => void;
  onSetOntology: React.Dispatch<React.SetStateAction<Ontology>>;
  onSetKG: React.Dispatch<React.SetStateAction<KnowledgeBase>>;
  onExport: () => void;
  onRestore: () => void;
  onImport: () => void;
}) {
  return (
    <section className="maintenance-shell">
      <div className="maintenance-hero">
        <div>
          <span className="eyebrow">维护工作台</span>
          <h1>
            让每一条关系，
            <em>都经得起追问。</em>
          </h1>
          <p>
            在浏览器内调整本体、事件与关系；改动保存在本机，导出后通过
            Pull Request 回写仓库。
          </p>
        </div>
        <div className="maintenance-actions">
          <button onClick={onImport}>导入快照</button>
          <button onClick={onRestore}>恢复仓库版本</button>
          <button className="primary" onClick={onExport}>
            导出 JSON
          </button>
        </div>
      </div>
      <div className="health-strip">
        <div>
          <span className={`health-icon ${errorCount ? "bad" : "good"}`}>
            {errorCount ? "!" : "✓"}
          </span>
          <p>
            <strong>{errorCount ? `${errorCount} 个错误` : "结构校验通过"}</strong>
            <span>引用、类型与证据完整性</span>
          </p>
        </div>
        <dl>
          <div><dt>实体</dt><dd>{kg.entities.length}</dd></div>
          <div><dt>事件</dt><dd>{kg.events.length}</dd></div>
          <div><dt>关系</dt><dd>{kg.eventRelations.length + kg.entityRelations.length}</dd></div>
          <div><dt>警告</dt><dd>{warningCount}</dd></div>
        </dl>
      </div>
      <nav className="maintenance-tabs" aria-label="维护数据类型">
        {[
          ["ontology", "本体类型"],
          ["events", "事件记录"],
          ["relations", "关系与证据"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={mode === id ? "active" : ""}
            onClick={() => onSetMode(id as MaintenanceMode)}
          >
            {label}
          </button>
        ))}
      </nav>

      {mode === "ontology" ? (
        <OntologyEditor
          ontology={ontology}
          selectedGroup={selectedOntologyGroup}
          selectedId={selectedOntologyId}
          onSetGroup={onSetOntologyGroup}
          onSetId={onSetOntologyId}
          onChange={onSetOntology}
        />
      ) : null}
      {mode === "events" ? (
        <EventEditor
          kg={kg}
          ontology={ontology}
          selectedId={selectedEventId}
          onSetId={onSetEventId}
          onChange={onSetKG}
        />
      ) : null}
      {mode === "relations" ? (
        <RelationEditor
          kg={kg}
          ontology={ontology}
          selectedId={selectedRelationId}
          onSetId={onSetRelationId}
          onChange={onSetKG}
        />
      ) : null}

      <div className="validation-drawer">
        <div>
          <h2>实时校验</h2>
          <span>
            {issues.length
              ? `${errorCount} 错误 · ${warningCount} 警告`
              : "没有发现问题"}
          </span>
        </div>
        {issues.length ? (
          <ul>
            {issues.slice(0, 8).map((issue, index) => (
              <li key={`${issue.path}-${index}`} className={issue.level}>
                <span>{issue.level === "error" ? "错误" : "警告"}</span>
                <code>{issue.path}</code>
                <p>{issue.message}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="validation-empty">
            所有事件均引用有效实体与来源；所有关系均有证据说明。
          </p>
        )}
      </div>
    </section>
  );
}

function OntologyEditor({
  ontology,
  selectedGroup,
  selectedId,
  onSetGroup,
  onSetId,
  onChange,
}: {
  ontology: Ontology;
  selectedGroup: "entityTypes" | "eventTypes" | "relationTypes";
  selectedId: string;
  onSetGroup: (
    group: "entityTypes" | "eventTypes" | "relationTypes",
  ) => void;
  onSetId: (id: string) => void;
  onChange: React.Dispatch<React.SetStateAction<Ontology>>;
}) {
  const values = ontology[selectedGroup];
  const selected = values.find((value) => value.id === selectedId) ?? values[0];
  const isRelation = selectedGroup === "relationTypes";

  const update = (field: string, value: string | boolean) => {
    onChange((current) => ({
      ...current,
      [selectedGroup]: current[selectedGroup].map((item) =>
        item.id === selected.id ? { ...item, [field]: value } : item,
      ),
    }));
  };

  const addType = () => {
    const baseId = `new-${selectedGroup.replace("Types", "")}`;
    let id = baseId;
    let suffix = 2;
    while (values.some((value) => value.id === id)) id = `${baseId}-${suffix++}`;
    const item =
      selectedGroup === "relationTypes"
        ? {
            id,
            label: "新关系",
            description: "请描述这条关系成立的判断标准。",
            from: ["event"],
            to: ["event"],
            directed: true,
          }
        : {
            id,
            label: "新类型",
            description: "请描述该类型的边界。",
            color: "#6f746e",
          };
    onChange((current) => ({
      ...current,
      [selectedGroup]: [...current[selectedGroup], item],
    }) as Ontology);
    onSetId(id);
  };

  return (
    <div className="editor-grid">
      <aside className="record-list">
        <div className="record-list-tabs">
          {[
            ["entityTypes", "实体"],
            ["eventTypes", "事件"],
            ["relationTypes", "关系"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={selectedGroup === id ? "active" : ""}
              onClick={() => {
                const group = id as typeof selectedGroup;
                onSetGroup(group);
                onSetId(ontology[group][0]?.id ?? "");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="record-list-head">
          <span>{values.length} 个类型</span>
          <button onClick={addType}>＋ 新建</button>
        </div>
        {values.map((value) => (
          <button
            key={value.id}
            className={selected?.id === value.id ? "selected" : ""}
            onClick={() => onSetId(value.id)}
          >
            {"color" in value ? (
              <i style={{ background: value.color }} />
            ) : (
              <i className="relation-record-icon" />
            )}
            <span>
              <strong>{value.label}</strong>
              <small>{value.id}</small>
            </span>
          </button>
        ))}
      </aside>
      {selected ? (
        <div className="record-editor">
          <div className="editor-heading">
            <div>
              <span className="panel-kicker">
                {isRelation ? "关系类型" : "节点类型"}
              </span>
              <h2>{selected.label}</h2>
            </div>
            <span className="local-badge">本地草稿</span>
          </div>
          <div className="form-grid">
            <label>
              显示名称
              <input
                value={selected.label}
                onChange={(event) => update("label", event.target.value)}
              />
            </label>
            <label>
              稳定 ID
              <input value={selected.id} disabled />
              <small>ID 一旦发布不建议修改</small>
            </label>
            {"color" in selected ? (
              <label>
                识别颜色
                <span className="color-input">
                  <input
                    type="color"
                    value={selected.color}
                    onChange={(event) => update("color", event.target.value)}
                  />
                  <input
                    value={selected.color}
                    onChange={(event) => update("color", event.target.value)}
                  />
                </span>
              </label>
            ) : null}
            {isRelation && "directed" in selected ? (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={selected.directed}
                  onChange={(event) => update("directed", event.target.checked)}
                />
                有方向关系
                <small>例如“回应”从后续事件指向所回应的问题</small>
              </label>
            ) : null}
            <label className="full-field">
              定义与边界
              <textarea
                rows={5}
                value={selected.description}
                onChange={(event) => update("description", event.target.value)}
              />
              <small>说明什么应该归入，以及与相邻类型的区别。</small>
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EventEditor({
  kg,
  ontology,
  selectedId,
  onSetId,
  onChange,
}: {
  kg: KnowledgeBase;
  ontology: Ontology;
  selectedId: string;
  onSetId: (id: string) => void;
  onChange: React.Dispatch<React.SetStateAction<KnowledgeBase>>;
}) {
  const selected =
    kg.events.find((event) => event.id === selectedId) ?? kg.events[0];
  const update = (field: keyof Event, value: Event[keyof Event]) => {
    onChange((current) => ({
      ...current,
      events: current.events.map((event) =>
        event.id === selected.id ? { ...event, [field]: value } : event,
      ),
    }));
  };

  return (
    <div className="editor-grid">
      <aside className="record-list event-records">
        <div className="record-list-head">
          <span>{kg.events.length} 个事件</span>
        </div>
        {kg.events
          .slice()
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((event) => (
            <button
              key={event.id}
              className={selected.id === event.id ? "selected" : ""}
              onClick={() => onSetId(event.id)}
            >
              <time>{event.date.slice(0, 4)}</time>
              <span>
                <strong>{event.title}</strong>
                <small>
                  {
                    ontology.eventTypes.find((type) => type.id === event.type)
                      ?.label
                  }
                </small>
              </span>
            </button>
          ))}
      </aside>
      <div className="record-editor">
        <div className="editor-heading">
          <div>
            <span className="panel-kicker">事件记录</span>
            <h2>{selected.title}</h2>
          </div>
          <span className="local-badge">实时校验</span>
        </div>
        <div className="form-grid">
          <label className="full-field">
            事件标题
            <input
              value={selected.title}
              onChange={(event) => update("title", event.target.value)}
            />
          </label>
          <label>
            事件日期
            <input
              type="date"
              value={selected.date}
              onChange={(event) => update("date", event.target.value)}
            />
          </label>
          <label>
            事件类型
            <select
              value={selected.type}
              onChange={(event) => update("type", event.target.value)}
            >
              {ontology.eventTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <label className="full-field">
            事实摘要
            <textarea
              rows={4}
              value={selected.summary}
              onChange={(event) => update("summary", event.target.value)}
            />
          </label>
          <label className="full-field">
            长期意义
            <textarea
              rows={4}
              value={selected.significance}
              onChange={(event) => update("significance", event.target.value)}
            />
          </label>
          <div className="full-field entity-checkboxes">
            <span>参与实体</span>
            <div>
              {kg.entities.map((entity) => (
                <label key={entity.id}>
                  <input
                    type="checkbox"
                    checked={selected.entityIds.includes(entity.id)}
                    onChange={(change) =>
                      update(
                        "entityIds",
                        change.target.checked
                          ? [...selected.entityIds, entity.id]
                          : selected.entityIds.filter((id) => id !== entity.id),
                      )
                    }
                  />
                  {entity.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RelationEditor({
  kg,
  ontology,
  selectedId,
  onSetId,
  onChange,
}: {
  kg: KnowledgeBase;
  ontology: Ontology;
  selectedId: string;
  onSetId: (id: string) => void;
  onChange: React.Dispatch<React.SetStateAction<KnowledgeBase>>;
}) {
  const selected =
    kg.eventRelations.find((relation) => relation.id === selectedId) ??
    kg.eventRelations[0];
  const update = (field: keyof Relation, value: Relation[keyof Relation]) => {
    onChange((current) => ({
      ...current,
      eventRelations: current.eventRelations.map((relation) =>
        relation.id === selected.id ? { ...relation, [field]: value } : relation,
      ),
    }));
  };

  const addRelation = () => {
    let suffix = kg.eventRelations.length + 1;
    let id = `rel-${suffix}`;
    while (kg.eventRelations.some((relation) => relation.id === id)) {
      id = `rel-${++suffix}`;
    }
    const next: Relation = {
      id,
      from: kg.events[0].id,
      to: kg.events[1]?.id ?? kg.events[0].id,
      type: "precedes",
      confidence: 0.5,
      evidence: "",
      sourceId: kg.sources[0].id,
    };
    onChange((current) => ({
      ...current,
      eventRelations: [...current.eventRelations, next],
    }));
    onSetId(id);
  };

  return (
    <div className="editor-grid">
      <aside className="record-list relation-records">
        <div className="record-list-head">
          <span>{kg.eventRelations.length} 条事件关系</span>
          <button onClick={addRelation}>＋ 新建</button>
        </div>
        {kg.eventRelations.map((relation) => (
          <button
            key={relation.id}
            className={selected.id === relation.id ? "selected" : ""}
            onClick={() => onSetId(relation.id)}
          >
            <i className="relation-record-icon" />
            <span>
              <strong>{relationLabel(ontology, relation.type)}</strong>
              <small>
                {kg.events.find((event) => event.id === relation.from)?.title}
              </small>
            </span>
          </button>
        ))}
      </aside>
      <div className="record-editor">
        <div className="editor-heading">
          <div>
            <span className="panel-kicker">事件关系</span>
            <h2>{relationLabel(ontology, selected.type)}</h2>
          </div>
          <span className="local-badge">
            置信度 {Math.round((selected.confidence ?? 1) * 100)}%
          </span>
        </div>
        <div className="form-grid">
          <label>
            起点事件
            <select
              value={selected.from}
              onChange={(event) => update("from", event.target.value)}
            >
              {kg.events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.date.slice(0, 4)} · {event.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            终点事件
            <select
              value={selected.to}
              onChange={(event) => update("to", event.target.value)}
            >
              {kg.events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.date.slice(0, 4)} · {event.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            关系类型
            <select
              value={selected.type}
              onChange={(event) => update("type", event.target.value)}
            >
              {ontology.relationTypes
                .filter(
                  (type: RelationType) =>
                    type.from.includes("event") && type.to.includes("event"),
                )
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            置信度
            <span className="range-field">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={selected.confidence ?? 1}
                onChange={(event) =>
                  update("confidence", Number(event.target.value))
                }
              />
              <b>{Math.round((selected.confidence ?? 1) * 100)}%</b>
            </span>
          </label>
          <label className="full-field">
            关系证据
            <textarea
              rows={6}
              value={selected.evidence}
              onChange={(event) => update("evidence", event.target.value)}
              placeholder="说明为什么这两个事件可以建立这条关系；必要时引用原文短句。"
            />
            <small>没有证据说明的关系会被校验器标记为错误。</small>
          </label>
          <label className="full-field">
            出处
            <select
              value={selected.sourceId}
              onChange={(event) => update("sourceId", event.target.value)}
            >
              {kg.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
