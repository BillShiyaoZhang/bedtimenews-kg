"use client";

import Link from "next/link";
import {
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  formatEventDate,
  type KnowledgeBase,
  type Ontology,
} from "../lib/kg";
import { KnowledgeGraphCanvas } from "./knowledge-graph-canvas";

const ENTITY_PICKER_LIMIT = 24;
const NEWS_LIMIT = 80;
const LOCATION_CHANGE_EVENT = "entity-location-change";

function subscribeToLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener(LOCATION_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(LOCATION_CHANGE_EVENT, callback);
  };
}

function getLocationSearch() {
  return window.location.search;
}

function getServerLocationSearch() {
  return "";
}

export function EntityGraphExplorer({
  knowledgeBase,
  ontology,
}: {
  knowledgeBase: KnowledgeBase;
  ontology: Ontology;
}) {
  const entityById = useMemo(
    () => new Map(knowledgeBase.entities.map((entity) => [entity.id, entity])),
    [knowledgeBase.entities],
  );
  const sourceById = useMemo(
    () => new Map(knowledgeBase.sources.map((source) => [source.id, source])),
    [knowledgeBase.sources],
  );
  const entityTypeById = useMemo(
    () => new Map(ontology.entityTypes.map((type) => [type.id, type])),
    [ontology.entityTypes],
  );
  const eventTypeById = useMemo(
    () => new Map(ontology.eventTypes.map((type) => [type.id, type])),
    [ontology.eventTypes],
  );
  const rankedEntities = useMemo(
    () =>
      [...knowledgeBase.entities].sort(
        (left, right) =>
          (right.extraction?.eventCount ?? 0) -
            (left.extraction?.eventCount ?? 0) ||
          left.label.localeCompare(right.label, "zh-CN"),
      ),
    [knowledgeBase.entities],
  );
  const defaultEntityId = rankedEntities[0]?.id ?? "";
  const locationSearch = useSyncExternalStore(
    subscribeToLocation,
    getLocationSearch,
    getServerLocationSearch,
  );
  const locationParameters = useMemo(
    () => new URLSearchParams(locationSearch),
    [locationSearch],
  );
  const requestedEntityId = locationParameters.get("entity");
  const selectedEntityId =
    requestedEntityId && entityById.has(requestedEntityId)
      ? requestedEntityId
      : defaultEntityId;
  const requestedEntityType = locationParameters.get("type");
  const initialEntityType =
    requestedEntityType &&
    ontology.entityTypes.some((type) => type.id === requestedEntityType)
      ? requestedEntityType
      : "";
  const [selectedEventOverride, setSelectedEventOverride] = useState("");
  const [entityQuery, setEntityQuery] = useState("");
  const [entityTypeOverride, setEntityTypeOverride] = useState<string | null>(
    null,
  );
  const entityType = entityTypeOverride ?? initialEntityType;

  const relatedEvents = useMemo(
    () =>
      knowledgeBase.events
        .filter((event) => event.entityIds.includes(selectedEntityId))
        .sort(
          (left, right) =>
            right.date.localeCompare(left.date) ||
            left.title.localeCompare(right.title, "zh-CN"),
        ),
    [knowledgeBase.events, selectedEntityId],
  );

  const selectedEventId = relatedEvents.some(
    (event) => event.id === selectedEventOverride,
  )
    ? selectedEventOverride
    : (relatedEvents[0]?.id ?? "");

  const selectedEntity = entityById.get(selectedEntityId);
  const selectedEvent = knowledgeBase.events.find(
    (event) => event.id === selectedEventId,
  );
  const selectedSource = selectedEvent
    ? sourceById.get(selectedEvent.sourceIds[0])
    : undefined;
  const selectedType = selectedEntity
    ? entityTypeById.get(selectedEntity.type)
    : undefined;

  const pickerEntities = useMemo(() => {
    const query = entityQuery.trim().toLocaleLowerCase("zh-CN");
    const matches = rankedEntities
      .filter((entity) => !entityType || entity.type === entityType)
      .filter((entity) => {
        if (!query) return true;
        return [entity.label, ...entity.aliases, entity.description]
          .join(" ")
          .toLocaleLowerCase("zh-CN")
          .includes(query);
      });
    const visible = matches.slice(0, ENTITY_PICKER_LIMIT);
    const current = entityById.get(selectedEntityId);
    if (
      current &&
      matches.includes(current) &&
      !visible.some((entity) => entity.id === current.id)
    ) {
      return [current, ...visible.slice(0, ENTITY_PICKER_LIMIT - 1)];
    }
    return visible;
  }, [
    entityById,
    entityQuery,
    entityType,
    rankedEntities,
    selectedEntityId,
  ]);

  const selectEntity = (id: string) => {
    if (!entityById.has(id)) return;
    const url = new URL(window.location.href);
    url.searchParams.set("entity", id);
    window.history.replaceState({}, "", url);
    window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <main className="detail-page">
      <header className="site-header detail-header">
        <Link className="brand" href="/" aria-label="返回历史经纬首页">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>历史经纬</strong>
            <small>Entity Knowledge Graph</small>
          </span>
        </Link>
        <nav aria-label="主要导航">
          <Link href="/">返回检索</Link>
          <Link href="/ontology">Ontology</Link>
        </nav>
      </header>

      <section className="entity-detail-hero">
        <div className="entity-identity">
          <span
            className="entity-type-badge"
            style={{ "--entity-color": selectedType?.color } as CSSProperties}
          >
            {selectedType?.label ?? selectedEntity?.type ?? "实体"}
          </span>
          <h1>{selectedEntity?.label ?? "选择一个实体"}</h1>
          <p>{selectedEntity?.description}</p>
          {selectedEntity?.aliases.length ? (
            <div className="entity-aliases">
              <span>别名</span>
              {selectedEntity.aliases.map((alias) => (
                <i key={alias}>{alias}</i>
              ))}
            </div>
          ) : null}
        </div>
        <dl className="entity-detail-stats">
          <div>
            <dt>相关新闻</dt>
            <dd>{relatedEvents.length.toLocaleString("zh-CN")}</dd>
          </div>
          <div>
            <dt>抽取置信度</dt>
            <dd>
              {selectedEntity?.extraction
                ? `${Math.round(selectedEntity.extraction.confidence * 100)}%`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>抽取方法</dt>
            <dd>{selectedEntity?.extraction?.method ?? "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="entity-picker" aria-label="切换实体">
        <div className="entity-picker-controls">
          <label>
            <span>查找其他实体</span>
            <input
              value={entityQuery}
              onChange={(event) => setEntityQuery(event.target.value)}
              placeholder="输入人物、组织、地点、主题或对象"
            />
          </label>
          <label>
            <span>实体类型</span>
            <select
              value={entityType}
              onChange={(event) => setEntityTypeOverride(event.target.value)}
            >
              <option value="">全部类型</option>
              {ontology.entityTypes.map((type) => (
                <option value={type.id} key={type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="entity-picker-results">
          {pickerEntities.map((entity) => (
            <button
              type="button"
              className={entity.id === selectedEntityId ? "active" : ""}
              onClick={() => selectEntity(entity.id)}
              key={entity.id}
            >
              <span>{entity.label}</span>
              <small>
                {entityTypeById.get(entity.type)?.label ?? entity.type} ·{" "}
                {entity.extraction?.eventCount ?? 0} 条
              </small>
            </button>
          ))}
        </div>
      </section>

      {selectedEntity ? (
        <section className="graph-news-workbench">
          <div className="graph-column">
            <div className="section-title">
              <div>
                <span className="eyebrow">Knowledge graph</span>
                <h2>实体与新闻关系</h2>
              </div>
              <p>点击节点可切换实体或查看新闻证据。</p>
            </div>
            <KnowledgeGraphCanvas
              kg={knowledgeBase}
              ontology={ontology}
              selectedEntityId={selectedEntity.id}
              selectedEventId={selectedEventId}
              onSelectEntity={selectEntity}
              onSelectEvent={setSelectedEventOverride}
            />
            {selectedEvent ? (
              <article className="selected-event-inspector">
                <div>
                  <span
                    style={
                      {
                        "--type-color": eventTypeById.get(selectedEvent.type)
                          ?.color,
                      } as CSSProperties
                    }
                  >
                    {eventTypeById.get(selectedEvent.type)?.label ??
                      selectedEvent.type}
                  </span>
                  <time>{formatEventDate(selectedEvent)}</time>
                </div>
                <h3>{selectedEvent.title}</h3>
                <p>{selectedEvent.summary || "原文未提供摘要。"}</p>
                <div className="inspector-entities">
                  {selectedEvent.entityIds.slice(0, 12).map((entityId) => {
                    const entity = entityById.get(entityId);
                    return entity ? (
                      <button
                        type="button"
                        onClick={() => selectEntity(entity.id)}
                        key={entity.id}
                      >
                        {entity.label}
                      </button>
                    ) : null;
                  })}
                </div>
                {selectedSource ? (
                  <a
                    href={selectedSource.archiveUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    阅读原文证据 ↗
                  </a>
                ) : null}
              </article>
            ) : null}
          </div>

          <aside className="news-column">
            <div className="section-title">
              <div>
                <span className="eyebrow">Related news</span>
                <h2>相关新闻时间线</h2>
              </div>
              <p>由近到远，点击后在图谱中定位。</p>
            </div>
            {relatedEvents.length ? (
              <div className="entity-news-list">
                {relatedEvents.slice(0, NEWS_LIMIT).map((event) => {
                  const eventTypeDefinition = eventTypeById.get(event.type);
                  const source = sourceById.get(event.sourceIds[0]);
                  return (
                    <article
                      className={
                        event.id === selectedEventId ? "active" : undefined
                      }
                      key={event.id}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedEventOverride(event.id)}
                      >
                        <span>
                          <time>{formatEventDate(event)}</time>
                          <i
                            style={
                              {
                                "--type-color": eventTypeDefinition?.color,
                              } as CSSProperties
                            }
                          >
                            {eventTypeDefinition?.label ?? event.type}
                          </i>
                        </span>
                        <strong>{event.title}</strong>
                        <small>{event.summary || "查看原文了解详情。"}</small>
                      </button>
                      {source ? (
                        <a
                          href={source.archiveUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`阅读原文：${source.title}`}
                        >
                          原文 ↗
                        </a>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-result">
                <strong>暂无关联新闻</strong>
                <p>这个实体尚未进入任何可发布新闻。</p>
              </div>
            )}
            {relatedEvents.length > NEWS_LIMIT ? (
              <p className="news-limit-note">
                当前显示最近 {NEWS_LIMIT} / {relatedEvents.length} 条。
              </p>
            ) : null}
          </aside>
        </section>
      ) : null}

      <footer>
        <span>实体、新闻与关系均来自可追溯的原文片段</span>
        <Link href="/">回到首页重新检索</Link>
      </footer>
    </main>
  );
}
