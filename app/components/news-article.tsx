"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import ontologyData from "../../data/ontology.json";
import { actionAssessmentLabel, actionMatchReasons } from "../lib/action-assessment.mjs";
import { formatEventDate, type Ontology } from "../lib/kg";
import type { NewsArticleData } from "../lib/reading-types";
import { ReportDescriptionDetails } from "./report-description-details";
import { useReader } from "./reader-provider";
import { archiveMedia } from "../lib/archive-media.mjs";

const ontology = ontologyData as unknown as Ontology;
export function resolveArchiveLink(href: string | undefined, repositoryPath: string, sourceCommit?: string) {
  if (!href) return undefined;
  if (/^(?:https?:|mailto:|#)/i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
  const base = sourceCommit ? `https://raw.githubusercontent.com/bedtimenews/bedtimenews-archive-contents/${sourceCommit}/${repositoryPath}` : `https://archive.bedtime.news/zh/${repositoryPath.replace(/\.md$/, "")}`;
  try { return new URL(href, base).href; } catch { return undefined; }
}
function ArchiveImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src) return <span className="reading-muted">图片地址不可用</span>;
  if (failed) return <a className="image-fallback" href={src} target="_blank" rel="noreferrer">图片暂时无法显示，打开原图 ↗{alt ? `（${alt}）` : ""}</a>;
  // Archive images retain their source URL; they are not copied into a new media archive.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt ?? "归档新闻配图"} loading="lazy" onError={() => setFailed(true)} />;
}
export function NewsArticle({ article }: { article: NewsArticleData }) {
  const reader = useReader(); const { markNewsRead } = reader; const [copied, setCopied] = useState(false);
  const { event, source } = article;
  const media = useMemo(() => archiveMedia(article.markdown ?? ""), [article.markdown]);
  useEffect(() => { markNewsRead(event.newsId, article.contentHash); }, [event.newsId, article.contentHash, markNewsRead]);
  const matches = actionMatchReasons(ontology, event, {});
  const copy = async () => {
    const anchor = document.querySelector<HTMLAnchorElement>(`a[data-canonical-news='${event.newsId}']`);
    try { await navigator.clipboard.writeText(anchor?.href ?? new URL(`/news/${event.newsId}/`, window.location.origin).href); setCopied(true); } catch { setCopied(false); }
  };
  return <article className="news-reading" data-news-id={event.newsId}>
    {article.preview && <p className="reading-notice">本地评审预览：正文已验签，尚未进入正式接受版本。</p>}
    <h1 tabIndex={-1} data-reading-heading>{event.title}</h1>
    <div className="reading-meta"><time>{formatEventDate(event)}</time><span>{source.episode ? `睡前消息 ${source.episode.number} 期` : source.title}</span></div>
    <div className="reading-actions"><Link prefetch={false} data-canonical-news={event.newsId} href={`/news/${event.newsId}/`}>独立页面 ↗</Link><button type="button" onClick={copy}>{copied ? "已复制链接" : "复制链接"}</button><button type="button" onClick={() => reader.markNewsRead(event.newsId, article.contentHash, !reader.isRead(event.newsId))}>{reader.isRead(event.newsId) ? "标记未读" : "标记已读"}</button><span className="sr-only" role="status">{copied ? "新闻链接已复制" : ""}</span></div>
    {article.contentStatus === "summary" && <p className="reading-notice">当前归档仅提供摘要，以下是归档保存的完整摘要片段。</p>}
    {article.contentStatus === "unrecorded" ? <section className="reading-unrecorded"><p className="reading-notice">此接受版本尚未收录正文。</p><p>{event.summary || "归档未提供摘要。"}</p><a href={source.archiveUrl} target="_blank" rel="noreferrer">查看原始档案 ↗</a></section> : media.videoOnly ? <p className="reading-notice">当前归档片段仅保存视频，没有文字正文。可以在原平台观看。</p> : <div className="reading-prose"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} urlTransform={(url) => resolveArchiveLink(url, source.repositoryPath)} components={{ img: ({ src, alt }) => <ArchiveImage src={typeof src === "string" ? src : undefined} alt={alt} />, a: ({ href, children }) => <a href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{children}</a> }}>{media.markdown}</Markdown></div>}
    {media.links.length > 0 && <div className="reading-media-links">{!media.videoOnly && <p className="reading-muted">归档还保存了视频，可以在原平台观看。</p>}{media.links.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label} ↗</a>)}</div>}
    {article.entities.length > 0 && <section className="reading-section"><h2>新闻涉及的实体</h2><div className="entity-tags">{article.entities.map((entity) => <button key={entity.id} type="button" onClick={() => reader.openEntity(entity.id)}>{entity.label}</button>)}</div></section>}
    {article.related.length > 0 && <section className="reading-section"><h2>共同涉及这些实体的报道</h2><div className="reading-related">{article.related.map((row) => <Link prefetch={false} key={row.newsId} href={`/news/${row.newsId}/`} onClick={(click) => reader.openNews(row.newsId, click)}><time>{formatEventDate(row)}</time><strong>{row.title}</strong></Link>)}</div></section>}
    <details className="reading-evidence"><summary>来源与证据</summary><p>来源：{source.title}</p><p><a href={source.archiveUrl} target="_blank" rel="noreferrer">可读归档 ↗</a> · <a href={source.repositoryUrl} target="_blank" rel="noreferrer">原始文件 ↗</a></p><small>片段 SHA-256：{article.contentHash}</small><section className="action-assessment-evidence"><h3>报道中的行动与变化</h3><p>{event.actionAssessment ? actionAssessmentLabel(ontology, "statuses", event.actionAssessment.status) : "此版本未记录"}</p>{matches.map((match) => <details key={`${match.conceptId}:${match.polarity}:${match.modality}`}><summary>{match.label} · {actionAssessmentLabel(ontology, "polarities", match.polarity)} · {actionAssessmentLabel(ontology, "modalities", match.modality)}</summary>{match.evidence.map((evidence: { scope: { text: string }; ruleId: string }, i: number) => <p key={`${evidence.ruleId}:${i}`}>{evidence.scope.text}</p>)}</details>)}<small>仅描述本条报道，不代表独立核实或因果判断。</small></section><ReportDescriptionDetails ontology={ontology} event={event} /></details>
  </article>;
}
