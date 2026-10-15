"use client";
import { useMemo, useSyncExternalStore } from "react";
import type { Entity, EntityType } from "../lib/kg";
import { createEntitySearchDocument, matchesSearchDocument, parseSearchQuery } from "../lib/search.mjs";
import { useReader } from "./reader-provider";
const subscribe = (callback: () => void) => {
  window.addEventListener("popstate", callback); window.addEventListener("kg-location-change", callback);
  return () => { window.removeEventListener("popstate", callback); window.removeEventListener("kg-location-change", callback); };
};
export function KnowledgeDirectory({ entities, types }: { entities: Entity[]; types: EntityType[] }) {
  const reader = useReader();
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  const parameters = useMemo(() => new URLSearchParams(search), [search]);
  const query = parameters.get("q") ?? "", type = parameters.get("entityType") ?? "";
  const documents = useMemo(() => new Map(entities.map((entity) => [entity.id, createEntitySearchDocument(entity)])), [entities]);
  const matches = useMemo(() => {
    const terms = parseSearchQuery(query);
    return entities.filter((entity) => (!type || entity.type === type) && matchesSearchDocument(documents.get(entity.id), terms)).sort((a, b) => (b.identityResolution?.newsCount ?? b.extraction?.eventCount ?? 0) - (a.identityResolution?.newsCount ?? a.extraction?.eventCount ?? 0) || a.label.localeCompare(b.label, "zh-CN"));
  }, [entities, type, query, documents]);
  const pages = Math.max(1, Math.ceil(matches.length / 20));
  const rawPage = Number(parameters.get("page"));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, pages) : 1;
  const navigate = (values: Record<string, string>, replace = false) => {
    const url = new URL(window.location.href); for (const [name, value] of Object.entries(values)) { if (value) url.searchParams.set(name, value); else url.searchParams.delete(name); }
    const state = { ...window.history.state }; delete state.atlasReader;
    window.history[replace ? "replaceState" : "pushState"](state, "", url); window.dispatchEvent(new Event("kg-location-change"));
  };
  return <section className="knowledge-directory"><h1>知识分类</h1><p>从人物、机构、地点和主题找到相关新闻，再沿着关系继续探索。</p><div className="directory-controls"><label className="sr-only" htmlFor="directory-search">搜索实体名称和别名</label><input id="directory-search" placeholder="搜索人物、机构、地点或主题" value={query} onChange={(event) => navigate({ q: event.target.value, page: "" }, true)} /></div><div className="directory-tabs" aria-label="实体分类"><button type="button" aria-pressed={!type} onClick={() => navigate({ entityType: "", page: "" })}>全部</button>{types.map((entry) => <button type="button" key={entry.id} aria-pressed={type === entry.id} onClick={() => navigate({ entityType: entry.id, page: "" })}>{entry.label}</button>)}</div><p>{matches.length} 个实体</p><div className="directory-list">{matches.slice((page - 1) * 20, page * 20).map((entity) => <button type="button" key={entity.id} onClick={() => reader.openEntity(entity.id)}><strong>{entity.label}</strong><small>{types.find((entry) => entry.id === entity.type)?.label} · {entity.identityResolution?.newsCount ?? entity.extraction?.eventCount ?? 0} 条相关新闻</small></button>)}</div>{!matches.length && <p>没有匹配的实体，试试其他名称或分类。</p>}{pages > 1 && <nav className="news-pagination" aria-label="知识分类分页"><button type="button" disabled={page === 1} onClick={() => navigate({ page: page === 2 ? "" : String(page - 1) })}>上一页</button><span>{page} / {pages}</span><button type="button" disabled={page === pages} onClick={() => navigate({ page: String(page + 1) })}>下一页</button></nav>}</section>;
}
