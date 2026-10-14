"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { formatEventDate, type KnowledgeBase, type Ontology } from "../lib/kg";
import { createEntitySearchDocument, matchesSearchDocument, parseSearchQuery } from "../lib/search.mjs";
import {
  createGraphIndex, readGraphLocation, graphLocationSearch, startExploration,
  expandEntity, continueBranch, collapseBranch, branchHasMore, fitGraphViewport,
  readGraphUndo, writeGraphHistory, readGraphTimelinePage, GRAPH_NODE_LIMIT, type Exploration, type Viewport,
  type TimelinePosition, type GraphUndoSnapshot,
} from "../lib/graph-exploration.mjs";
import { KnowledgeGraphCanvas } from "./knowledge-graph-canvas";
import { useReader } from "./reader-provider";

const LOCATION_CHANGE_EVENT = "kg-location-change";
const NEWS_PAGE_SIZE = 20;
type LocationSnapshot = { search: string; saved: Exploration | null; undoCount: number; timeline: TimelinePosition | null };

function subscribeToLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener(LOCATION_CHANGE_EVENT, callback);
  return () => { window.removeEventListener("popstate", callback); window.removeEventListener(LOCATION_CHANGE_EVENT, callback); };
}

function getLocationSnapshot() {
  return JSON.stringify({ search: window.location.search, saved: window.history.state?.graphExploration ?? null,
    undoCount: window.history.state?.graphUndo?.length ?? 0, timeline: window.history.state?.graphTimeline ?? null });
}

function getServerLocationSnapshot() { return ""; }
function notifyLocation() { window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT)); }

export function EntityGraphExplorer({ knowledgeBase, ontology }: { knowledgeBase: KnowledgeBase; ontology: Ontology }) {
  const reader = useReader();
  const index = useMemo(() => createGraphIndex(knowledgeBase), [knowledgeBase]);
  const snapshot = useSyncExternalStore(subscribeToLocation, getLocationSnapshot, getServerLocationSnapshot);
  const location = useMemo<LocationSnapshot>(() => snapshot ? JSON.parse(snapshot) : { search: "", saved: null, undoCount: 0, timeline: null }, [snapshot]);
  const parameters = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const graph = useMemo(() => readGraphLocation(location.search, index, location.saved), [location, index]);
  const focusedEntity = index.entities.get(graph.focusId);
  const rootEntity = index.entities.get(graph.rootId);
  const requestedIdentityId = graph.focusId || graph.rootId;
  const requestedRawIdentity = knowledgeBase.identityNavigation?.find((row) => row.rawEntityId === requestedIdentityId);
  const requestedRegistration = knowledgeBase.identityRegistrations?.find((row) => row.id === requestedIdentityId);
  const entityTypeById = useMemo(() => new Map(ontology.entityTypes.map((type) => [type.id, type])), [ontology]);
  const eventTypeById = useMemo(() => new Map(ontology.eventTypes.map((type) => [type.id, type])), [ontology]);
  const sourceById = useMemo(() => new Map(knowledgeBase.sources.map((source) => [source.id, source])), [knowledgeBase]);
  const relatedNews = index.byEntity.get(graph.focusId) ?? [];
  const pageCount = Math.max(1, Math.ceil(relatedNews.length / NEWS_PAGE_SIZE));
  const page = readGraphTimelinePage(location.search, graph.focusId, pageCount, location.timeline);
  const [entityQueryOverride, setEntityQuery] = useState<string | null>(null);
  const entityQuery = entityQueryOverride ?? parameters.get("q") ?? "";
  const [entityTypeOverride, setEntityTypeOverride] = useState<string | null>(null);
  const [mobileGraphOpen, setMobileGraphOpen] = useState(false);
  const requestedType = parameters.get("type") ?? "";
  const entityType = entityTypeOverride ?? (entityTypeById.has(requestedType) ? requestedType : "");
  const pickerEntities = useMemo(() => {
    const terms = parseSearchQuery(entityQuery);
    return knowledgeBase.entities.filter((entity) => !entityType || entity.type === entityType)
      .filter((entity) => matchesSearchDocument(createEntitySearchDocument(entity, entityTypeById.get(entity.type)), terms))
      .sort((a, b) => (index.byEntity.get(b.id)?.length ?? 0) - (index.byEntity.get(a.id)?.length ?? 0) || a.label.localeCompare(b.label, "zh-CN"))
      .slice(0, entityQuery.trim() ? 24 : 12);
  }, [knowledgeBase.entities, entityType, entityQuery, entityTypeById, index]);

  const persist = (next: Exploration, options: { replace?: boolean; undo?: GraphUndoSnapshot[]; remember?: boolean; timeline?: TimelinePosition | null } = {}) => {
    const url = new URL(window.location.href);
    const current = { ...window.history.state, graphTimeline: { focusId: graph.focusId, page } };
    // Preserve the graph and its viewport in the entry we are about to leave.
    if (!options.replace) window.history.replaceState({ ...current, graphExploration: graph }, "", window.location.href);
    const state = writeGraphHistory(current, graph, next, options);
    url.search = graphLocationSearch(next, url.search, state.graphTimeline?.page ?? 1);
    if (options.replace) window.history.replaceState(state, "", url);
    else window.history.pushState(state, "", url);
    notifyLocation();
  };
  const restart = (entityId: string) => {
    const next = startExploration(index, entityId);
    persist({ ...next, viewport: fitGraphViewport(next.nodes) }, { timeline: { focusId: entityId, page: 1 } });
  };
  const selectEntity = (entityId: string) => {
    const next = expandEntity(graph, index, entityId);
    if (next === graph || (next.focusId === graph.focusId && next.nodes.length === graph.nodes.length && !next.notice)) return;
    persist(next);
  };
  const undo = () => {
    const rows = readGraphUndo(window.history.state ?? {});
    const previous = rows.at(-1);
    if (previous) persist(previous.graph, { undo: rows.slice(0, -1), remember: false, timeline: previous.timeline });
  };
  const changeViewport = (viewport: Viewport) => persist({ ...graph, viewport }, { replace: true, remember: false });
  const changePage = (next: number) => {
    persist(graph, { replace: true, timeline: { focusId: graph.focusId, page: Math.max(1, Math.min(pageCount, next)) } });
  };
  const toggleMobileGraph = () => {
    const next = !mobileGraphOpen;
    setMobileGraphOpen(next);
    window.requestAnimationFrame(() => {
      const heading = document.getElementById(next ? "graph-heading" : "entity-related-news-heading");
      if (!heading) return;
      heading.tabIndex = -1;
      heading.scrollIntoView({ block: "start", behavior: "auto" });
      heading.focus({ preventScroll: true });
    });
  };
  const focusBranch = graph.branches.find((row) => row.entityId === graph.focusId);

  return (
    <main className="detail-page entity-workbench-page">
      <header className="site-header detail-header">
        <Link prefetch={false} className="brand" href="/" aria-label="历史经纬首页"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span><strong>历史经纬</strong><small>每天读新闻，看清来龙去脉</small></span></Link>
        <nav aria-label="主要导航"><Link prefetch={false} href="/">新闻检索</Link><Link prefetch={false} href="/graph" aria-current="page">实体探索</Link><Link prefetch={false} href="/ontology">知识分类</Link></nav>
      </header>

      {!graph.rootId ? (
        <section className="graph-entry"><span className="eyebrow">实体探索</span><h1>从一个熟悉的名字开始</h1><p>查找人物、组织、地点或主题，先读相关新闻，再沿着关联继续探索。</p></section>
      ) : (
        <section className="entity-profile">
          {rootEntity && <div className="graph-history"><span>探索起点</span><button type="button" onClick={() => selectEntity(rootEntity.id)}>{rootEntity.label}</button>{focusedEntity && graph.focusId !== graph.rootId && <><span aria-hidden="true">›</span><span>当前查看：{focusedEntity.label}</span></>}</div>}
          <span className="entity-type-badge" style={{ "--entity-color": entityTypeById.get(focusedEntity?.type ?? requestedRawIdentity?.type ?? requestedRegistration?.type ?? "")?.color } as CSSProperties}>{entityTypeById.get(focusedEntity?.type ?? requestedRawIdentity?.type ?? requestedRegistration?.type ?? "")?.label ?? "实体"}</span>
          <h1>{focusedEntity?.label ?? requestedRawIdentity?.label ?? requestedRegistration?.label ?? "未找到这个实体"}</h1>
          {focusedEntity && <><p>{relatedNews.length.toLocaleString("zh-CN")} 条相关新闻{relatedNews[0] ? ` · 最近报道 ${formatEventDate(relatedNews[0])}` : ""}</p><button type="button" onClick={() => reader.openEntity(focusedEntity.id)}>查看实体资料</button></>}
          {!!focusedEntity?.aliases.length && <p className="entity-aliases">也称：{focusedEntity.aliases.join("、")}</p>}
          {requestedRegistration && !focusedEntity && <p>{requestedRegistration.state === "tombstoned" ? "该身份已停用。" : "该身份目前没有有效新闻关联。"}历史资料仍保留在对应版本中。</p>}
          {graph.rootId && !focusedEntity && !requestedRawIdentity && !requestedRegistration && <p>这个实体不在当前版本中。可以在下方查找其他名字。</p>}
          {requestedRawIdentity && <div className="identity-review-notice"><p>{requestedRawIdentity.state === "cleared" ? "该名称的新闻已恢复原始归属。" : requestedRawIdentity.state === "dormant" ? "这个历史名称目前没有有效新闻支持。" : "这个名称在不同新闻中有不同身份归属。"}请选择下方具体对象；同名不会自动合并。</p><ul>{requestedRawIdentity.targets.map((target) => <li key={target.id}><Link prefetch={false} href={`/graph?entity=${encodeURIComponent(target.id)}`}>{target.label}（{target.newsCount} 条新闻）</Link></li>)}</ul></div>}
          {focusedEntity && <button className="graph-mobile-toggle" type="button" aria-expanded={mobileGraphOpen} aria-controls="entity-graph-workbench" onClick={toggleMobileGraph}>{mobileGraphOpen ? "收起关系图谱" : "展开关系图谱"}</button>}
        </section>
      )}

      <details className="entity-picker" open={!graph.rootId}>
        <summary>{graph.rootId ? "添加实体或换个起点" : "选择一个探索起点"}</summary>
        <div className="entity-picker-controls">
          <label><span>{graph.rootId ? "查找其他实体" : "查找实体"}</span><input type="search" value={entityQuery} onChange={(event) => setEntityQuery(event.target.value)} placeholder="例如：中国、人工智能、铁路" /></label>
          <label><span>类型</span><select value={entityType} onChange={(event) => setEntityTypeOverride(event.target.value)}><option value="">全部类型</option>{ontology.entityTypes.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select></label>
        </div>
        <div className="graph-entry-grid">
          {pickerEntities.map((entity) => <div className={`entity-picker-item ${entity.id === graph.focusId ? "active" : ""}`} key={entity.id}>
            <div><strong>{entity.label}</strong><small>{entityTypeById.get(entity.type)?.label ?? entity.type} · {index.byEntity.get(entity.id)?.length ?? 0} 条新闻</small></div>
            <div className="graph-branch-actions"><button type="button" onClick={() => graph.rootId && rootEntity ? selectEntity(entity.id) : restart(entity.id)}>{graph.rootId && rootEntity ? graph.branches.some((row) => row.entityId === entity.id) ? "查看" : "加入图谱" : "从这里开始"}</button>{graph.rootId && rootEntity && entity.id !== graph.rootId && <button type="button" onClick={() => restart(entity.id)}>作为新起点</button>}</div>
          </div>)}
        </div>
        {!pickerEntities.length && <p className="empty-result">没有找到这个名字，试试别名或减少一个关键词。</p>}
      </details>

      {focusedEntity && <section className="graph-workbench">
        <section className="entity-related-news" aria-labelledby="entity-related-news-heading">
          <div className="section-title"><div><span className="eyebrow">跟着报道看变化</span><h2 id="entity-related-news-heading">{focusedEntity.label}的相关新闻</h2></div><p>从最近开始 · 共 {relatedNews.length} 条</p></div>
          {relatedNews.length ? <div className="entity-news-list">
            {relatedNews.slice((page - 1) * NEWS_PAGE_SIZE, page * NEWS_PAGE_SIZE).map((event) => <article key={event.id} className={`news-list-item ${graph.newsId === event.newsId ? "active" : ""} ${reader.isRead(event.newsId) ? "is-read" : ""}`}>
              <div className="result-meta"><time>{formatEventDate(event)}</time><span>{eventTypeById.get(event.type)?.label ?? event.type}</span>{reader.isNew(event.newsId) && <span className="news-new-badge">新</span>}{reader.isRead(event.newsId) && <span>已读</span>}</div>
              <h3><Link prefetch={false} href={`/news/${event.newsId}/`} onClick={(click) => reader.openNews(event.newsId, click)}>{event.title}</Link></h3>
              <p>{event.summary || "打开新闻查看归档内容。"}</p>
              {sourceById.get(event.sourceIds[0]) && <small>{sourceById.get(event.sourceIds[0])?.title}</small>}
              <div className="entity-tags">{event.entityIds.filter((id) => id !== graph.focusId).slice(0, 5).map((id) => {
                const entity = index.entities.get(id);
                return entity ? <button type="button" key={id} onClick={() => selectEntity(id)} title={`在现有图谱中展开 ${entity.label}`}>{entity.label}</button> : null;
              })}</div>
            </article>)}
          </div> : <div className="empty-result"><strong>暂无相关新闻</strong><p>当前版本还没有关联到这个实体的新闻。</p></div>}
          {pageCount > 1 && <nav className="news-pagination" aria-label="相关新闻分页"><button type="button" onClick={() => changePage(page - 1)} disabled={page === 1}>上一页</button><span aria-live="polite">第 {page} / {pageCount} 页</span><button type="button" onClick={() => changePage(page + 1)} disabled={page === pageCount}>下一页</button></nav>}
        </section>

        <div className="graph-column">
          <section id="entity-graph-workbench" className={`entity-graph-workbench ${mobileGraphOpen ? "graph-open-on-mobile" : "graph-collapsed-on-mobile"}`} aria-labelledby="graph-heading">
            <div className="section-title"><div><span className="eyebrow">沿着关联继续看</span><h2 id="graph-heading">关系图谱</h2></div><p>点击实体扩展，保留已有内容</p></div>
            <div className="graph-toolbar" aria-label="探索操作">
              <button className="graph-mobile-toggle" type="button" onClick={toggleMobileGraph}>收起图谱并返回新闻</button>
              <button type="button" onClick={undo} disabled={!location.undoCount}>撤销上一步</button>
              <button type="button" onClick={() => restart(graph.rootId)}>重置到起点</button>
              {graph.focusId !== graph.rootId && <button type="button" onClick={() => restart(graph.focusId)}>以当前实体重新开始</button>}
            </div>
            <KnowledgeGraphCanvas graph={graph} ontology={ontology} onSelectEntity={selectEntity} onSelectNews={(id) => reader.openNews(id)} onViewportChange={changeViewport} />
            <div className="graph-branch-actions">
              <button type="button" onClick={() => persist(continueBranch(graph, index, graph.focusId))} disabled={graph.nodes.length >= GRAPH_NODE_LIMIT || !branchHasMore(graph, index, graph.focusId)}>{focusBranch ? "继续展开当前实体" : "展开当前实体"}</button>
              <button type="button" onClick={() => persist(collapseBranch(graph, index, graph.focusId))} disabled={!focusBranch}>收起当前分支</button>
            </div>
            <p className="graph-exploration-status" role="status">{graph.notice || `已展开 ${graph.branches.length} 个实体，共 ${graph.nodes.length} / ${GRAPH_NODE_LIMIT} 个节点；每次最多增加 10 条新闻和 6 个关联实体。`}</p>
          </section>
        </div>
      </section>}
      <footer><span>实体关联用于帮助阅读，报道先后不代表因果关系。</span><Link prefetch={false} href="/">返回新闻首页</Link></footer>
    </main>
  );
}
