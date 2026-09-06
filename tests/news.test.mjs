import assert from "node:assert/strict";
import test from "node:test";
import {
  maskHtmlComments,
  parseSourcePage,
  readNewsFragment,
  reconcileEpisodeDates,
} from "../scripts/lib/news.mjs";

test("HTML comment masking preserves source positions and hides unfinished comments", () => {
  const raw = "正文<!-- 模板说明\r\n\r\n## 隐藏标题\n-->继续正文<!-- 未闭合说明";
  const masked = maskHtmlComments(raw);
  assert.equal(masked.length, raw.length);
  assert.deepEqual(masked.match(/\r\n|\n/gu), raw.match(/\r\n|\n/gu));
  assert.equal(masked.indexOf("继续正文"), raw.indexOf("继续正文"));
  assert.doesNotMatch(masked, /模板说明|隐藏标题|未闭合说明/u);
});

test("multiline comments cannot supply news titles, summaries, or horizontal boundaries", () => {
  const first = "第一条新闻讨论人工智能技术进展，研究团队公布了一项重要的实验结果";
  const raw = `---
title: 两条独立新闻
published: true
---

# Tabs {.tabset}

<!-- 这里是视频账号与模板的维护说明，长度足够被旧版拆分器误认为新闻正文

## 隐藏的假新闻标题

---

<font color="indigo">昨天的消息，隐藏的新闻不应该被识别为独立边界。</font>

-->

${first}。这项研究包含具体的数据和技术方案，相关团队介绍了实验过程与后续计划。该段还提供充分的背景和事实描述，以便作为一条内容完整的独立新闻，并且不会因为页面长度不足而退回整页模式。

---

## 第二条具体新闻

第二条新闻讨论铁路建设的最新进展，工程团队介绍了建设过程和通车计划。这条新闻与上一条科研新闻的主题不同，需要保留各自的标题、摘要和原文范围。报道还给出了具体的工程背景、涉及地点和实施进展，为读者提供完整的信息与可以追溯的原始证据。`;
  const result = parseSourcePage("main/1-100/comments.md", raw);

  assert.equal(result.page.segmentation.strategy, "horizontal_rule");
  assert.equal(result.page.segmentation.candidateBoundaryCount, 1);
  assert.equal(result.news.length, 2);
  assert.equal(result.news[0].title, first);
  assert.ok(result.news[0].summary.startsWith(first));
  assert.equal(result.news[1].title, "第二条具体新闻");
  for (const item of result.news) {
    assert.doesNotMatch(item.title + item.summary, /模板|隐藏|<!--/u);
  }
  assert.match(readNewsFragment(raw, result.news[0].fragment), /<!--/u);
  assert.match(readNewsFragment(raw, result.news[1].fragment), /铁路建设/u);
});

test("commented numbered headings do not create news or change visible news identities", () => {
  const raw = `---
title: 测试日报
published: true
---

## 1、第一条新闻

第一条新闻有明确的主题和足够长的事实描述，需要保留准确的原文片段、标题与摘要，供后续检索使用。

## 2、第二条新闻

第二条新闻同样有自己的事实背景和具体内容，不应因为插入模板注释而改变它的稳定新闻标识。`;
  const commented = raw.replace(
    "## 2、第二条新闻",
    "<!--\n\n## 99、隐藏的标题\n\n隐藏内容不能成为新闻，尽管它有足够多的文字并且看起来很像一个编号新闻段落。\n\n-->\n\n## 2、第二条新闻",
  );
  const original = parseSourcePage("daily/2026/07/23.md", raw);
  const result = parseSourcePage("daily/2026/07/23.md", commented);

  assert.equal(result.news.length, 2);
  assert.deepEqual(
    result.news.map((item) => item.id),
    original.news.map((item) => item.id),
  );
  assert.match(readNewsFragment(commented, result.news[0].fragment), /隐藏的标题/u);
  assert.match(readNewsFragment(commented, result.news[1].fragment), /## 2、第二条新闻/u);
});

test("navigation indexes remain excluded when their link lists are commented out", () => {
  const raw = `---
title: 第701-800期
published: true
---

> 这段时间暂无节目更新。

<!--
- [701](./701-800/701.md)
- [702](./701-800/702.md)
- [703](./701-800/703.md)
- [704](./701-800/704.md)
- [705](./701-800/705.md)
-->`;
  assert.equal(parseSourcePage("main/701-800.md", raw), null);
});

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

test("manual title exclusions remove non-news sections without changing boundaries", () => {
  const raw = `---
title: 测试日报
published: true
---

## 1、欢迎收看今天的节目

这是节目串场，不是独立新闻，因此应该通过人工审查配置从最终数据集中移除。

## 2、第二条新闻

第二条新闻讨论一项具体事件，包含足够长的事实描述，应该继续保留并维持原有边界。`;
  const result = parseSourcePage("daily/2026/07/23.md", raw, {
    excludeTitles: ["欢迎收看今天的节目"],
  });

  assert.equal(result.news.length, 1);
  assert.equal(result.news[0].title, "第二条新闻");
  assert.equal(result.page.segmentation.strategy, "daily_numbered_heading");
});

test("manual title exclusions fail when a reviewed title disappears", () => {
  const raw = `---
title: 测试日报
published: true
---

## 1、第一条新闻

第一条新闻的正文。`;

  assert.throws(
    () =>
      parseSourcePage("daily/2026/07/23.md", raw, {
        excludeTitles: ["已经消失的标题"],
      }),
    /Manual excluded news title not found/u,
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

test("news titles omit page series and episode prefixes", () => {
  const raw = `---
title: 【睡前消息12】第一条具体新闻
published: true
dateCreated: 2020-01-01T00:00:00Z
---

## 第一条具体新闻

第一条新闻的正文内容足够长，用来确认即使分段标题来自页面，新闻名称也不会继续显示节目名称和期号。这里再补充一些正文，确保它能够通过片段长度检查。第一条新闻还包含背景、主体、地点、时间与具体进展，因此能够作为独立记录被检索和展示，而不是继续沿用整个节目页面的名称。

---

## 第二条具体新闻

第二条新闻讨论另一个完全不同的话题，同样提供足够长的正文内容，以便水平分隔线被识别为两条独立新闻。第二条新闻也补充了自己的背景、相关主体和结果，确保拆分器能够确认这是内容完整且主题不同的另一个新闻片段。`;
  const result = parseSourcePage("main/1-100/12.md", raw);

  assert.equal(result.page.title, "【睡前消息12】第一条具体新闻");
  assert.equal(result.news.length, 2);
  assert.equal(result.news[0].title, "第一条具体新闻");
  assert.equal(result.news[1].title, "第二条具体新闻");
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
