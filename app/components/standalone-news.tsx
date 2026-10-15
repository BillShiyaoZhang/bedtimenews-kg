"use client";
import { useEffect, useState } from "react";
import { NewsArticle } from "./news-article";
import type { NewsArticleData } from "../lib/reading-types";
export function StandaloneNews({ assetUrl, title, summary }: { assetUrl: string; title: string; summary: string }) {
  const [article, setArticle] = useState<NewsArticleData | null>(null); const [error, setError] = useState(false); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(assetUrl, { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("Missing article"); return response.json(); }).then((value) => { setArticle(value); setError(false); }).catch((failure) => { if (failure.name !== "AbortError") setError(true); });
    return () => controller.abort();
  }, [assetUrl, attempt]);
  if (article) return <NewsArticle article={article} />;
  return <article className="news-reading"><h1>{title}</h1><p>{summary}</p>{error ? <div role="alert" className="reading-message"><p>暂时无法加载正文。新闻信息已保留，可以重试。</p><button type="button" onClick={() => { setError(false); setAttempt(attempt + 1); }}>重试</button></div> : <p role="status">正在加载新闻片段…</p>}</article>;
}
