// Archive video embeds become ordinary links. The original Markdown and its
// accepted fragment hash remain unchanged; remote HTML is never embedded.
export function archiveMedia(markdown = "") {
  const visible = markdown.replace(/<!--[\s\S]*?-->/gu, "");
  const frames = /<iframe\b([^>]*)>[\s\S]*?<\/iframe\s*>/giu;
  const links = new Map();
  for (const frame of visible.matchAll(frames)) {
    const source = frame[1].match(/(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu);
    if (!source) continue;
    try {
      const url = new URL((source[1] ?? source[2] ?? source[3]).replaceAll("&amp;", "&"), "https://archive.bedtime.news/");
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
      const host = url.hostname.toLowerCase();
      let label = `原平台视频（${host}）`;
      if (host === "player.bilibili.com") {
        label = "在哔哩哔哩查看视频";
        const bvid = url.searchParams.get("bvid");
        if (/^BV[a-z0-9]+$/iu.test(bvid ?? "")) { url.hostname = "www.bilibili.com"; url.pathname = `/video/${bvid}/`; url.search = ""; }
      } else if (["www.youtube.com", "www.youtube-nocookie.com", "youtube.com"].includes(host)) {
        label = "在 YouTube 查看视频";
        const id = url.pathname.match(/^\/embed\/([a-z0-9_-]+)$/iu)?.[1];
        if (id) { url.hostname = "www.youtube.com"; url.pathname = "/watch"; url.search = `?v=${id}`; }
      }
      links.set(url.href, { href: url.href, label });
    } catch { /* Invalid archive URLs do not produce navigable links. */ }
  }
  const navigation = /^\s*#{0,6}\s*(?:Tabs\s*(?:\{\.tabset\})?|\{\.tabset\}|B站|YouTube|西瓜视频)\s*$/gimu;
  const emptyHeading = /^\s*#{1,6}\s*$/gmu;
  const readingMarkdown = links.size > 0 ? visible.replace(frames, "").replace(navigation, "").replace(emptyHeading, "") : visible;
  const text = readingMarkdown.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/giu, "")
    .replace(frames, "").replace(/<[^>]*>/gu, "").trim();
  return { links: [...links.values()], videoOnly: links.size > 0 && text.length === 0, markdown: readingMarkdown };
}
