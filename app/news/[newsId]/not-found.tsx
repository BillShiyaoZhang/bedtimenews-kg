import Link from "next/link";
export default function NewsNotFound() { return <main className="reading-message standalone-article"><h1>未找到这条新闻</h1><p>这个新闻 ID 不在当前发布版本中。</p><Link prefetch={false} href="/">返回新闻与检索 →</Link></main>; }
