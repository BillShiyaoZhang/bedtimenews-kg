"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { beginVisit, markRead, clearReadMemory } from "../lib/reading-memory.mjs";
import type { ReaderCatalog, NewsArticleData, EntityArticleData } from "../lib/reading-types";
import { formatEventDate } from "../lib/kg";
import { NewsArticle } from "./news-article";

type ReaderContextType = {
  openNews: (newsId: string, event?: MouseEvent<HTMLAnchorElement>) => void;
  openEntity: (entityId: string) => void;
  isRead: (newsId: string) => boolean; isNew: (newsId: string) => boolean;
  clearReadingHistory: () => void; newCount: number;
  hasPreviousVisit: boolean;
  updateRecorded: boolean | null;
  markNewsRead: (newsId: string, hash: string, read?: boolean) => void;
};
const ReaderContext = createContext<ReaderContextType | null>(null);
export function useReader() { const value = useContext(ReaderContext); if (!value) throw new Error("ReaderProvider is required"); return value; }
const events = ["popstate", "kg-location-change", "entity-location-change", "kg-search-location-change"];
const subscribe = (callback: () => void) => { events.forEach((event) => window.addEventListener(event, callback)); return () => events.forEach((event) => window.removeEventListener(event, callback)); };
const location = () => window.location.search;
const serverLocation = () => "";
const isVisible = (element: Element) => {
  if (!element.getClientRects().length || typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true })) return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(":scope > summary")?.contains(element)) return false;
  }
  return true;
};
const readerKeyAtLocation = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("inspectEntity") ? `entities/${params.get("inspectEntity")}` : params.get("news") ? `news/${params.get("news")}` : "";
};
const storage = (kind: "localStorage" | "sessionStorage") => { try { return window[kind]; } catch { return undefined; } };
const requests = new Map<string, Promise<NewsArticleData | EntityArticleData>>();

export function ReaderProvider({ children, catalogUrl }: { children: ReactNode; catalogUrl: string }) {
  const [catalog, setCatalog] = useState<ReaderCatalog | null>(null);
  const [readHashes, setReadHashes] = useState<Record<string, string>>({});
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [hasPreviousVisit, setHasPreviousVisit] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; data: NewsArticleData | EntityArticleData } | null>(null);
  const [failure, setFailure] = useState<{ key: string; status: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const trigger = useRef<HTMLElement | null>(null);
  const hadReader = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const scrollPane = useRef<HTMLDivElement>(null);
  const search = useSyncExternalStore(subscribe, location, serverLocation);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const entityId = params.get("inspectEntity") || null; const newsId = params.get("news") || null;
  const key = entityId ? `entities/${entityId}` : newsId ? `news/${newsId}` : "";
  const requestedId = entityId ?? newsId ?? "";
  const validId = /^[a-z0-9_-]+$/i.test(requestedId);
  const shown = loaded?.key === key ? loaded.data : null;
  const failureStatus = !validId ? 404 : failure?.key === key ? failure.status : null;
  const assetRoot = catalogUrl.replace(/\/catalog\.json$/, "");
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1099px)");
    const update = () => setMobile(media.matches); update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(catalogUrl, { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("Catalog unavailable"); return response.json(); }).then((value: ReaderCatalog) => {
      const visit = beginVisit(value, storage("localStorage"), storage("sessionStorage"));
      setCatalog(value); setReadHashes((current) => ({ ...visit.memory.read, ...current })); setNewIds(new Set(visit.newIds)); setHasPreviousVisit(visit.hasPreviousVisit);
    }).catch(() => { /* Content and canonical links remain usable without memory. */ });
    return () => controller.abort();
  }, [catalogUrl]);
  const markNewsRead = useCallback((id: string, hash: string, read = true) => {
    markRead(storage("localStorage"), id, hash, read);
    setReadHashes((current) => { const next = { ...current }; if (read) next[id] = hash; else delete next[id]; return next; });
  }, []);
  useEffect(() => {
    if (!key || !validId) return;
    const url = `${assetRoot}/${entityId ? "entities" : "news"}/${encodeURIComponent(requestedId)}.json`;
    let active = true;
    if (!requests.has(url)) requests.set(url, fetch(url).then(async (response) => {
      if (!response.ok) throw Object.assign(new Error("Article unavailable"), { status: response.status });
      const data = await response.json();
      const valid = entityId ? data?.entity?.id === requestedId && Array.isArray(data.related) : data?.event?.newsId === requestedId && data?.source?.archiveUrl && Array.isArray(data.entities) && Array.isArray(data.related);
      if (!valid) throw new Error("Article schema does not match the requested record");
      return data;
    }));
    requests.get(url)!.then((data) => { if (active) { setLoaded({ key, data }); setFailure(null); } }).catch((error) => {
      requests.delete(url); if (active) setFailure({ key, status: error.status ?? 0 });
    });
    return () => { active = false; };
  }, [key, assetRoot, retry, requestedId, entityId, validId]);
  useEffect(() => {
    if (!key) return;
    const previous = document.body.style.overflow;
    if (mobile) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [key, mobile]);
  const saveReaderPosition = useCallback(() => {
    if (shown && key === readerKeyAtLocation() && scrollPane.current) {
      window.history.replaceState({ ...window.history.state, atlasReaderScroll: { key, top: scrollPane.current.scrollTop } }, "", window.location.href);
    }
  }, [shown, key]);
  useEffect(() => {
    if (!shown || !scrollPane.current) return;
    const saved = window.history.state?.atlasReaderScroll;
    scrollPane.current.scrollTop = saved?.key === key && Number.isFinite(saved.top) && saved.top >= 0 ? saved.top : 0;
    const container = scrollPane.current;
    container.addEventListener("scroll", saveReaderPosition, { passive: true });
    return () => container.removeEventListener("scroll", saveReaderPosition);
  }, [shown, key, search, saveReaderPosition]);
  useEffect(() => {
    if (key) hadReader.current = true;
    if (shown) panel.current?.querySelector<HTMLElement>("[data-reading-heading]")?.focus({ preventScroll: true });
    else if (key) panel.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    else if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
    else if (hadReader.current) Array.from(document.querySelectorAll<HTMLElement>(".graph-node-focus,.entity-profile h1,#keyword,#directory-search,.graph-seed-picker input")).find(isVisible)?.focus({ preventScroll: true });
    if (!key) hadReader.current = false;
  }, [shown, key]);
  const navigate = useCallback((next: URL) => {
    if (next.href === window.location.href) return;
    saveReaderPosition();
    const state = { ...window.history.state, atlasReader: { url: next.href, parentUrl: window.location.href } }; delete state.atlasReaderScroll;
    window.history.pushState(state, "", next);
    window.dispatchEvent(new Event("kg-location-change"));
  }, [saveReaderPosition]);
  const openNews = useCallback((id: string, event?: MouseEvent<HTMLAnchorElement>) => {
    if (event && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    event?.preventDefault();
    if (!new URLSearchParams(window.location.search).get("news") && !new URLSearchParams(window.location.search).get("inspectEntity")) trigger.current = event?.currentTarget ?? (document.activeElement as HTMLElement);
    const url = new URL(window.location.href); url.searchParams.set("news", id); url.searchParams.delete("inspectEntity"); url.searchParams.delete("inspectPage"); navigate(url);
  }, [navigate]);
  const openEntity = useCallback((id: string) => {
    if (!new URLSearchParams(window.location.search).get("news") && !new URLSearchParams(window.location.search).get("inspectEntity")) trigger.current = document.activeElement as HTMLElement;
    const url = new URL(window.location.href); url.searchParams.set("inspectEntity", id); url.searchParams.delete("inspectPage"); navigate(url);
  }, [navigate]);
  const close = useCallback((all = true) => {
    saveReaderPosition();
    const url = new URL(window.location.href);
    const marker = window.history.state?.atlasReader;
    const owned = marker?.url === url.href;
    const parent = marker?.parentUrl ? new URL(marker.parentUrl) : null;
    const parentHasReader = parent && (parent.searchParams.has("news") || parent.searchParams.has("inspectEntity"));
    if (owned && (!all || !parentHasReader)) window.history.back();
    else {
      if (!all && url.searchParams.has("inspectEntity") && url.searchParams.has("news")) { url.searchParams.delete("inspectEntity"); url.searchParams.delete("inspectPage"); }
      else { url.searchParams.delete("news"); url.searchParams.delete("inspectEntity"); url.searchParams.delete("inspectPage"); }
      const state = { ...window.history.state }; delete state.atlasReader;
      window.history.replaceState(state, "", url); window.dispatchEvent(new Event("kg-location-change"));
    }
  }, [saveReaderPosition]);
  useEffect(() => {
    if (!key) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(true); }
      if (event.key === "Tab" && mobile) {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),summary,[tabindex='0']") ?? []).filter(isVisible);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, [key, mobile, close]);
  const value = useMemo<ReaderContextType>(() => ({ openNews, openEntity, markNewsRead,
    isRead: (id) => !!catalog?.hashes[id] && readHashes[id] === catalog.hashes[id], isNew: (id) => newIds.has(id), newCount: newIds.size, hasPreviousVisit, updateRecorded: catalog?.recorded ?? null,
    clearReadingHistory: () => { clearReadMemory(storage("localStorage")); setReadHashes({}); },
  }), [openNews, openEntity, markNewsRead, catalog, readHashes, newIds, hasPreviousVisit]);
  return <ReaderContext.Provider value={value}><div inert={mobile && !!key || undefined} aria-hidden={mobile && !!key || undefined}>{children}</div>{key && <div className="reading-layer">
    {mobile && <div className="reading-backdrop" aria-hidden="true" />}
    <div ref={panel} className="reading-panel" role={mobile ? "dialog" : "region"} aria-modal={mobile || undefined} aria-label={entityId ? "实体资料" : "新闻阅读"}>
      <header className="reading-toolbar"><button type="button" onClick={() => close(false)}>← 返回</button><span>{entityId ? "实体与相关新闻" : "新闻阅读"}</span><button type="button" onClick={() => close(true)} aria-label="关闭阅读面板">✕</button></header>
      <div ref={scrollPane} className="reading-panel-scroll">
        {shown && !entityId ? <NewsArticle key={newsId} article={shown as NewsArticleData} /> : shown && entityId ? <EntityPreview key={entityId} article={shown as EntityArticleData} /> : failureStatus !== null ? <div className="reading-message" role="alert"><h2 data-reading-heading tabIndex={-1}>{failureStatus === 404 ? "未找到这条记录" : "暂时无法加载内容"}</h2><p>{failureStatus === 404 ? "这个 ID 不在当前发布版本中。" : "列表和探索位置已保留，可以重试加载。"}</p>{failureStatus !== 404 && <button type="button" onClick={() => setRetry((n) => n + 1)}>重试</button>}</div> : <div className="reading-skeleton" role="status" aria-live="polite"><p>正在打开内容…</p><i /><i /><i /></div>}
      </div>
    </div>
  </div>}</ReaderContext.Provider>;
}

function EntityPreview({ article }: { article: EntityArticleData }) {
  const reader = useReader(); const search = useSyncExternalStore(subscribe, location, serverLocation);
  const pages = Math.max(1, Math.ceil(article.related.length / 20));
  const requestedPage = Number(new URLSearchParams(search).get("inspectPage"));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(pages, requestedPage) : 1;
  const setPage = (page: number) => {
    const url = new URL(window.location.href); if (page > 1) url.searchParams.set("inspectPage", String(page)); else url.searchParams.delete("inspectPage");
    const state = { ...window.history.state }; delete state.atlasReaderScroll;
    if (state.atlasReader?.url === window.location.href) state.atlasReader = { ...state.atlasReader, url: url.href };
    window.history.replaceState(state, "", url); window.dispatchEvent(new Event("kg-location-change"));
  };
  return <article className="entity-reading"><h1 data-reading-heading tabIndex={-1}>{article.entity.label}</h1><p>{article.entity.description}</p>{article.entity.aliases.length > 0 && <p className="reading-muted">也称：{article.entity.aliases.join("、")}</p>}<Link prefetch={false} className="primary-link" href={`/graph/?entity=${encodeURIComponent(article.entity.id)}`}>以此实体探索关系 →</Link><h2>{article.total} 条相关新闻</h2><div className="reading-related">{article.related.slice((page - 1) * 20, page * 20).map((event) => <Link prefetch={false} href={`/news/${event.newsId}/`} key={event.newsId} onClick={(click) => reader.openNews(event.newsId, click)}><time>{formatEventDate(event)}</time><strong>{event.title}</strong><p>{event.summary}</p></Link>)}</div>{pages > 1 && <nav className="news-pagination" aria-label="实体相关新闻分页"><button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {pages}</span><button type="button" disabled={page === pages} onClick={() => setPage(page + 1)}>下一页</button></nav>}</article>;
}
