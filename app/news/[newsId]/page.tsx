import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import newsData from "../../../data/processed/news.json";
import manifest from "../../lib/reading-manifest.generated.json";
import { StandaloneNews } from "../../components/standalone-news";

const news = new Map(newsData.news.map((item) => [item.id, item]));
export function generateStaticParams() { return newsData.news.map((item) => ({ newsId: item.id })); }
export async function generateMetadata({ params }: { params: Promise<{ newsId: string }> }): Promise<Metadata> {
  const { newsId } = await params; const item = news.get(newsId);
  return item ? { title: `${item.title}｜历史经纬`, description: item.summary, alternates: { canonical: `/news/${newsId}/` } } : { title: "未找到新闻｜历史经纬" };
}
export default async function NewsPage({ params }: { params: Promise<{ newsId: string }> }) {
  const { newsId } = await params; const item = news.get(newsId); if (!item) notFound();
  const assetUrl = `${manifest.catalogUrl.replace(/\/catalog\.json$/, "")}/news/${newsId}.json`;
  return <main className="standalone-reading"><header className="site-header"><Link prefetch={false} className="brand" href="/"><strong>历史经纬</strong></Link><nav aria-label="主要导航"><Link prefetch={false} href="/">最新新闻与检索</Link><Link prefetch={false} href="/graph/">探索关系</Link><Link prefetch={false} href="/ontology/">知识分类</Link></nav></header><div className="standalone-article"><StandaloneNews assetUrl={assetUrl} title={item.title} summary={item.summary} /></div></main>;
}
