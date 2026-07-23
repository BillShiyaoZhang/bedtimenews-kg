import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSourcePage,
  readNewsFragment,
  reconcileEpisodeDates,
} from "../scripts/lib/news.mjs";

test("numbered page sections become independent news with exact provenance", () => {
  const raw = `---
title: 测试日报
published: true
dateCreated: 2026-07-23T00:00:00Z
---

## 1、第一条新闻

第一条新闻的事实段落足够长，用来验证每一条新闻都有独立标题、摘要和原始页面行号。

## 2、第二条新闻

第二条新闻讨论完全不同的主题，也应该成为独立记录而不是页面级记录。`;
  const result = parseSourcePage("daily/2026/07/23.md", raw);

  assert.equal(result.news.length, 2);
  assert.equal(result.news[0].title, "第一条新闻");
  assert.equal(result.news[1].title, "第二条新闻");
  assert.equal(result.news[0].pageId, result.page.id);
  assert.match(
    readNewsFragment(raw, result.news[1].fragment),
    /第二条新闻讨论完全不同的主题/u,
  );
});

test("manual markers provide a reviewable correction layer", () => {
  const raw = `---
title: 访谈
published: true
---

开场。

<font color="indigo">第一条边界新闻，内容是什么？</font>

第一条内容足够长，应该保留为第一个片段中的正文材料。

<font color="indigo">这是追问，不应该成为边界吗？</font>

追问回答。

<font color="indigo">第二条边界新闻，内容是什么？</font>

第二条内容足够长，应该保留为第二个片段中的正文材料。`;
  const result = parseSourcePage("main/1-100/test.md", raw, {
    boundaryMarkers: ["第一条边界新闻", "第二条边界新闻"],
  });

  assert.equal(result.page.segmentation.strategy, "manual_markers");
  assert.equal(result.news.length, 2);
  assert.match(
    readNewsFragment(raw, result.news[0].fragment),
    /这是追问/u,
  );
});

test("metadata-only reference pages split description sentences with column provenance", () => {
  const raw = `---
title: 参考信息
description: 第一条元数据新闻有独立主题。第二条元数据新闻讨论另一件事。
published: true
---

## Tabs {.tabset}`;
  const result = parseSourcePage("reference/501-600/test.md", raw);

  assert.equal(result.news.length, 2);
  assert.equal(
    result.news[0].fragment.sourceField,
    "frontmatter.description",
  );
  assert.equal(
    readNewsFragment(raw, result.news[1].fragment),
    "第二条元数据新闻讨论另一件事。",
  );
});

test("episode preamble date wins over later archive-import metadata", () => {
  const raw = `---
title: 【睡前消息1】测试
published: true
dateCreated: 2023-01-24T11:34:04.477Z
---

睡前消息：19/7/12

<font color="indigo">昨天发生了第一条值得记录的新闻，应该继承节目日期。</font>

这是一段足够长的正文，用来确保测试片段不会因为长度阈值被过滤掉。`;
  const result = parseSourcePage("main/1-100/test-date.md", raw);

  assert.equal(result.page.publishedAt, "2019-07-12");
  assert.equal(result.news[0].date, "2019-07-12");
});

test("episode dates follow increasing title numbers and retain provenance", () => {
  const pages = [
    episodePage(1, "2019-07-12", "episode_preamble"),
    episodePage(2, "2023-01-24", "frontmatter"),
    episodePage(3, "2019-07-18", "episode_preamble"),
  ];
  const news = pages.map((page) => ({
    id: `news-${page.episode.number}`,
    pageId: page.id,
    date: page.publishedAt,
    datePrecision: "day",
  }));

  const summary = reconcileEpisodeDates(pages, news);

  assert.equal(pages[1].publishedAt, "2019-07-15");
  assert.equal(pages[1].dateProvenance.observedAt, "2023-01-24");
  assert.equal(pages[1].dateProvenance.resolution, "interpolated");
  assert.equal(news[1].date, "2019-07-15");
  assert.equal(summary.adjustedPages, 1);
});

test("years in special-edition titles are not treated as episode numbers", () => {
  const raw = `---
title: 【睡前消息2023暑假版第一期】测试
published: true
dateCreated: 2023-07-20T00:00:00Z
---

这一期是暑假特别节目，正文长度足够构造一条页面回退新闻记录。`;
  const result = parseSourcePage("main/2023-summer/test.md", raw);

  assert.equal(result.page.episode, undefined);
});

function episodePage(number, publishedAt, source) {
  return {
    id: `page-${number}`,
    repositoryPath: `main/${number}.md`,
    publishedAt,
    dateProvenance: {
      observedAt: publishedAt,
      source,
      resolution: "observed",
    },
    episode: { series: "bedtimenews", number },
  };
}
