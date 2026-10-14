import Link from "next/link";
export default function NotFound() { return <main className="standalone-article reading-message"><h1>没有找到这个页面</h1><p>链接可能已失效，或记录不在当前发布版本中。</p><Link prefetch={false} href="/">返回最新新闻与检索 →</Link></main>; }
