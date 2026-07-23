import { createHash } from "node:crypto";
import { basename } from "node:path";

export const NEWS_DATASET_SCHEMA_VERSION = "1.1.0";
export const SEGMENTATION_VERSION = "1.1.0";

const MEDIA_HEADING = /^(?:Tabs|B站|西瓜视频|YouTube|播客)$/iu;
const NUMBERED_HEADING =
  /^#{1,3}\s+(?:\[?\s*\d+\s*[.、．)]\s*\]?\s*)(.+)$/u;
const INTERVIEW_PROMPT =
  /<font\b[^>]*\bcolor\s*=\s*["']?\s*indigo\s*["']?[^>]*>([\s\S]*?)<\/font>/iu;
const EXPLICIT_TRANSITION =
  /^(?:接下来|下面|再来看看|再看|最后|另一个|另外(?:一|个|则|条)|还有(?:一|个|则|条)|下一(?:个|则|条)|第二(?:个|则|条)|第三(?:个|则|条)|国际新闻|国内新闻|最近(?:有|一|，|,)|前天的消息|昨天的消息)/u;
const DATE_LEAD =
  /^(?:当地时间\s*)?(?:(?:18|19|20)?\d{2}年\s*)?(?:\d{1,2}月\d{1,2}[日号]|昨天|前天|本周|上周|近日|日前|今年|去年|这个月|刚刚过去的)/u;
const REPORTING_LANGUAGE =
  /(?:报道|消息|通报|发布|宣布|披露|发生|去世|辞职|当选|开工|投产|判决|调查|改革|袭击|事故|会议|文件|数据|研究|公司|政府|法院|委员会|总统|部长)/u;
const FOLLOW_UP_LEAD =
  /^(?:那|那么|这个|这次|这种|这些|为什么|怎么|督工|就是说|也就是说|如果|既然|所以|有人|你(?:觉得|认为|怎么看)|对于|从.+看|相比|前面|上面|刚才|除了|过去几年|这之后)/u;
const DATE_SOURCES = new Set([
  "repository_path",
  "episode_preamble",
  "page_title",
  "frontmatter",
  "unknown",
]);
const DATE_RESOLUTIONS = new Set([
  "observed",
  "interpolated",
  "corrected_sequence_outlier",
  "extrapolated",
]);

export function parseSourcePage(repositoryPath, raw, overrides = {}) {
  const parsed = parseFrontMatter(raw);
  if (
    String(parsed.attributes.published).toLocaleLowerCase("en-US") === "false" ||
    isNavigationIndex(parsed.body)
  ) {
    return null;
  }

  const sourceTitle =
    parsed.attributes.title ||
    firstHeading(parsed.body) ||
    basename(repositoryPath, ".md");
  const pageId = `page-${shortHash(repositoryPath)}`;
  const dateObservation = extractDate(
    repositoryPath,
    parsed.body,
    parsed.attributes,
  );
  const episode = extractEpisode(sourceTitle);
  const pageDate = dateObservation.date;
  const segmentation = segmentNews(
    repositoryPath,
    parsed.bodyLines,
    sourceTitle,
    parsed.attributes.description,
    overrides,
    parsed.attributeLocations,
  );
  if (!segmentation.sections.length) return null;

  const page = {
    id: pageId,
    title: sourceTitle,
    archiveUrl: archiveUrl(repositoryPath),
    repositoryPath,
    repositoryUrl:
      "https://github.com/bedtimenews/bedtimenews-archive-contents/blob/main/" +
      repositoryPath,
    publishedAt: pageDate,
    dateProvenance: {
      observedAt: pageDate,
      source: dateObservation.source,
      resolution: "observed",
    },
    ...(episode ? { episode } : {}),
    kind: pageKind(repositoryPath),
    contentHash: sha256(raw),
    segmentation: {
      strategy: segmentation.strategy,
      confidence: segmentation.confidence,
      newsCount: segmentation.sections.length,
      candidateBoundaryCount: segmentation.candidateBoundaryCount,
      needsReview: segmentation.reviewReasons.length > 0,
      reviewReasons: segmentation.reviewReasons,
    },
  };

  const news = segmentation.sections.map((section, ordinal) => {
    const sourceField = section.sourceField ?? "body";
    const rawSection =
      sourceField === "body"
        ? parsed.bodyLines.slice(section.start, section.end).join("\n")
        : section.metadataText;
    const explicitDate = extractExplicitDate(rawSection);
    const hasPageDate = pageDate && pageDate !== "1900-01-01";
    const date = hasPageDate
      ? pageDate
      : explicitDate?.date ?? "1900-01-01";
    const title =
      cleanText(section.title).slice(0, 160) ||
      (segmentation.sections.length === 1
        ? sourceTitle
        : `${sourceTitle} · ${ordinal + 1}`);
    const summary =
      cleanText(section.summary || meaningfulParagraph(rawSection)).slice(
        0,
        420,
      );
    const marker = cleanText(section.marker || title).slice(0, 220);
    return {
      id: `news-${shortHash(
        `${repositoryPath}\0${segmentation.strategy}\0${marker}`,
      )}`,
      title,
      date,
      datePrecision: hasPageDate
        ? datePrecision(date)
        : explicitDate?.precision ?? datePrecision(date),
      summary,
      pageId,
      fragment: {
        strategy: segmentation.strategy,
        ordinal: ordinal + 1,
        sourceField,
        startLine:
          sourceField === "body"
            ? parsed.bodyStartLine + section.start
            : section.metadataLine,
        endLine:
          sourceField === "body"
            ? parsed.bodyStartLine + section.end - 1
            : section.metadataLine,
        ...(sourceField === "body"
          ? {}
          : {
              startColumn: section.startColumn,
              endColumn: section.endColumn,
            }),
        marker,
        contentHash: sha256(rawSection),
      },
    };
  });

  return { page, news };
}

export function reconcileEpisodeDates(pages, news) {
  const episodes = pages
    .filter((page) => page.episode?.series === "bedtimenews")
    .sort(
      (left, right) =>
        left.episode.number - right.episode.number ||
        left.repositoryPath.localeCompare(right.repositoryPath),
    );
  if (!episodes.length) {
    return { episodePages: 0, adjustedPages: 0, rejectedAnchors: 0 };
  }

  const trusted = episodes.filter(
    (page) =>
      page.dateProvenance.source !== "frontmatter" &&
      page.dateProvenance.source !== "unknown" &&
      page.publishedAt !== "1900-01-01",
  );
  const retainedAnchors = longestNondecreasingDateSequence(trusted);
  const retainedIds = new Set(retainedAnchors.map((page) => page.id));
  const typicalDaysPerEpisode = medianEpisodeInterval(retainedAnchors);
  const newsByPageId = Map.groupBy(news, (item) => item.pageId);
  let adjustedPages = 0;

  for (const page of episodes) {
    const originalDate = page.publishedAt;
    let resolvedDate = originalDate;
    let resolution = "observed";
    if (!retainedIds.has(page.id)) {
      const previous = findAnchor(
        retainedAnchors,
        page.episode.number,
        "previous",
      );
      const next = findAnchor(retainedAnchors, page.episode.number, "next");
      if (previous && next) {
        resolvedDate = interpolateEpisodeDate(previous, next, page);
        resolution =
          page.dateProvenance.source === "frontmatter" ||
          page.dateProvenance.source === "unknown"
            ? "interpolated"
            : "corrected_sequence_outlier";
      } else if (previous) {
        resolvedDate = offsetEpisodeDate(
          previous,
          page,
          typicalDaysPerEpisode,
        );
        resolution = "extrapolated";
      } else if (next) {
        resolvedDate = offsetEpisodeDate(next, page, typicalDaysPerEpisode);
        resolution = "extrapolated";
      }
    }

    page.publishedAt = resolvedDate;
    page.dateProvenance.resolution = resolution;
    if (resolvedDate !== originalDate) adjustedPages += 1;
    for (const item of newsByPageId.get(page.id) ?? []) {
      item.date = resolvedDate;
      item.datePrecision = datePrecision(resolvedDate);
    }
  }

  return {
    episodePages: episodes.length,
    adjustedPages,
    rejectedAnchors: trusted.length - retainedAnchors.length,
  };
}

export function readNewsFragment(raw, fragment) {
  const lines = raw.split(/\r?\n/u);
  const content =
    fragment.sourceField === "frontmatter.description"
      ? lines[fragment.startLine - 1]?.slice(
          fragment.startColumn - 1,
          fragment.endColumn,
        ) ?? ""
      : lines
          .slice(fragment.startLine - 1, fragment.endLine)
          .join("\n");
  const contentHash = sha256(content);
  if (contentHash !== fragment.contentHash) {
    throw new Error(
      `News fragment hash mismatch at lines ${fragment.startLine}-${fragment.endLine}: ` +
        `expected ${fragment.contentHash}, received ${contentHash}.`,
    );
  }
  return content;
}

export function validateNewsDataset(dataset) {
  const issues = [];
  if (dataset.schemaVersion !== NEWS_DATASET_SCHEMA_VERSION) {
    issues.push(
      issue(
        "schemaVersion",
        `expected ${NEWS_DATASET_SCHEMA_VERSION}, received ${dataset.schemaVersion}`,
      ),
    );
  }
  if (dataset.segmentation?.version !== SEGMENTATION_VERSION) {
    issues.push(
      issue(
        "segmentation.version",
        `expected ${SEGMENTATION_VERSION}, received ${dataset.segmentation?.version}`,
      ),
    );
  }
  const pageIds = uniqueIds(dataset.pages ?? [], "pages", issues);
  uniqueIds(dataset.news ?? [], "news", issues);
  const episodePages = [];
  const episodeNumbers = new Map();
  for (const [index, page] of (dataset.pages ?? []).entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(page.publishedAt)) {
      issues.push(
        issue(`pages.${index}.publishedAt`, `invalid date ${page.publishedAt}`),
      );
    }
    if (!page.dateProvenance) {
      issues.push(
        issue(`pages.${index}.dateProvenance`, "missing date provenance"),
      );
    } else if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(page.dateProvenance.observedAt)
    ) {
      issues.push(
        issue(
          `pages.${index}.dateProvenance.observedAt`,
          `invalid date ${page.dateProvenance.observedAt}`,
        ),
      );
    }
    if (
      page.dateProvenance &&
      !DATE_SOURCES.has(page.dateProvenance.source)
    ) {
      issues.push(
        issue(
          `pages.${index}.dateProvenance.source`,
          `unknown date source ${page.dateProvenance.source}`,
        ),
      );
    }
    if (
      page.dateProvenance &&
      !DATE_RESOLUTIONS.has(page.dateProvenance.resolution)
    ) {
      issues.push(
        issue(
          `pages.${index}.dateProvenance.resolution`,
          `unknown date resolution ${page.dateProvenance.resolution}`,
        ),
      );
    }
    if (!page.episode) continue;
    if (
      page.episode.series !== "bedtimenews" ||
      !Number.isFinite(page.episode.number) ||
      page.episode.number <= 0
    ) {
      issues.push(issue(`pages.${index}.episode`, "invalid episode identity"));
      continue;
    }
    const duplicate = episodeNumbers.get(page.episode.number);
    if (duplicate) {
      issues.push(
        issue(
          `pages.${index}.episode.number`,
          `duplicate episode number ${page.episode.number} on ${duplicate}`,
        ),
      );
    } else {
      episodeNumbers.set(page.episode.number, page.repositoryPath);
    }
    episodePages.push(page);
  }
  episodePages.sort(
    (left, right) => left.episode.number - right.episode.number,
  );
  for (let index = 1; index < episodePages.length; index += 1) {
    const previous = episodePages[index - 1];
    const current = episodePages[index];
    if (previous.publishedAt > current.publishedAt) {
      issues.push(
        issue(
          `pages.${current.id}.publishedAt`,
          `episode ${current.episode.number} (${current.publishedAt}) is earlier than ` +
            `episode ${previous.episode.number} (${previous.publishedAt})`,
        ),
      );
    }
  }
  const seenFragments = new Set();
  const pagesById = new Map(
    (dataset.pages ?? []).map((page) => [page.id, page]),
  );
  for (const [index, item] of (dataset.news ?? []).entries()) {
    if (!pageIds.has(item.pageId)) {
      issues.push(issue(`news.${index}.pageId`, `missing page ${item.pageId}`));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(item.date)) {
      issues.push(issue(`news.${index}.date`, `invalid date ${item.date}`));
    }
    const page = pagesById.get(item.pageId);
    if (page?.episode && item.date !== page.publishedAt) {
      issues.push(
        issue(
          `news.${index}.date`,
          `episode news date ${item.date} does not match page date ${page.publishedAt}`,
        ),
      );
    }
    if (
      !Number.isInteger(item.fragment?.startLine) ||
      !Number.isInteger(item.fragment?.endLine) ||
      item.fragment.startLine < 1 ||
      item.fragment.endLine < item.fragment.startLine
    ) {
      issues.push(issue(`news.${index}.fragment`, "invalid source line range"));
    }
    if (
      item.fragment.sourceField === "frontmatter.description" &&
      (!Number.isInteger(item.fragment.startColumn) ||
        !Number.isInteger(item.fragment.endColumn) ||
        item.fragment.startColumn < 1 ||
        item.fragment.endColumn < item.fragment.startColumn)
    ) {
      issues.push(
        issue(`news.${index}.fragment`, "invalid metadata column range"),
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(item.fragment?.contentHash ?? "")) {
      issues.push(issue(`news.${index}.fragment.contentHash`, "invalid SHA-256"));
    }
    const fragmentKey = [
      item.pageId,
      item.fragment?.sourceField,
      item.fragment?.startLine,
      item.fragment?.endLine,
      item.fragment?.startColumn,
      item.fragment?.endColumn,
    ].join(":");
    if (seenFragments.has(fragmentKey)) {
      issues.push(issue(`news.${index}.fragment`, "duplicate page fragment"));
    }
    seenFragments.add(fragmentKey);
  }
  return issues;
}

export function validateKnowledgeBaseNewsProjection(kg, dataset) {
  const issues = [];
  const eventsByNewsId = new Map(
    (kg.events ?? []).map((event) => [event.newsId, event]),
  );
  const sourcesById = new Map(
    (kg.sources ?? []).map((source) => [source.id, source]),
  );
  if ((kg.events?.length ?? 0) !== (dataset.news?.length ?? 0)) {
    issues.push(
      issue(
        "events",
        `KG has ${kg.events?.length ?? 0} news projections; dataset has ${dataset.news?.length ?? 0}`,
      ),
    );
  }
  if ((kg.sources?.length ?? 0) !== (dataset.pages?.length ?? 0)) {
    issues.push(
      issue(
        "sources",
        `KG has ${kg.sources?.length ?? 0} pages; dataset has ${dataset.pages?.length ?? 0}`,
      ),
    );
  }
  for (const [index, item] of (dataset.news ?? []).entries()) {
    const event = eventsByNewsId.get(item.id);
    if (!event) {
      issues.push(
        issue(`news.${index}.id`, `missing KG projection for ${item.id}`),
      );
      continue;
    }
    if (event.sourceIds?.length !== 1 || event.sourceIds[0] !== item.pageId) {
      issues.push(
        issue(
          `events.${event.id}.sourceIds`,
          `${item.id} must reference page ${item.pageId}`,
        ),
      );
    }
    for (const field of ["title", "date", "datePrecision", "summary"]) {
      if (event[field] !== item[field]) {
        issues.push(
          issue(
            `events.${event.id}.${field}`,
            `does not match processed news ${item.id}`,
          ),
        );
      }
    }
  }
  for (const [index, page] of (dataset.pages ?? []).entries()) {
    const source = sourcesById.get(page.id);
    if (!source) {
      issues.push(
        issue(`pages.${index}.id`, `missing KG page projection for ${page.id}`),
      );
    } else if (
      source.repositoryPath !== page.repositoryPath ||
      source.contentHash !== page.contentHash
    ) {
      issues.push(
        issue(
          `sources.${source.id}`,
          `does not match processed page ${page.id}`,
        ),
      );
    }
  }
  return issues;
}

export function buildSegmentationReport(dataset) {
  const pagesByStrategy = Object.create(null);
  const episodeDateResolutions = Object.create(null);
  let multiNewsPages = 0;
  let reviewPages = 0;
  for (const page of dataset.pages) {
    pagesByStrategy[page.segmentation.strategy] =
      (pagesByStrategy[page.segmentation.strategy] ?? 0) + 1;
    if (page.segmentation.newsCount > 1) multiNewsPages += 1;
    if (page.segmentation.needsReview) reviewPages += 1;
    if (page.episode) {
      const resolution = page.dateProvenance.resolution;
      episodeDateResolutions[resolution] =
        (episodeDateResolutions[resolution] ?? 0) + 1;
    }
  }
  return {
    schemaVersion: 2,
    generatedAt: dataset.generatedAt,
    segmentationVersion: dataset.segmentation.version,
    summary: {
      pages: dataset.pages.length,
      news: dataset.news.length,
      multiNewsPages,
      reviewPages,
      pagesByStrategy,
      episodeDateResolutions,
    },
    episodeDateAdjustments: dataset.pages
      .filter(
        (page) =>
          page.episode &&
          page.dateProvenance.observedAt !== page.publishedAt,
      )
      .map((page) => ({
        pageId: page.id,
        repositoryPath: page.repositoryPath,
        episodeNumber: page.episode.number,
        observedAt: page.dateProvenance.observedAt,
        publishedAt: page.publishedAt,
        source: page.dateProvenance.source,
        resolution: page.dateProvenance.resolution,
      })),
    needsReview: dataset.pages
      .filter((page) => page.segmentation.needsReview)
      .map((page) => ({
        pageId: page.id,
        repositoryPath: page.repositoryPath,
        title: page.title,
        newsCount: page.segmentation.newsCount,
        strategy: page.segmentation.strategy,
        reasons: page.segmentation.reviewReasons,
      })),
  };
}

export function cleanText(value = "") {
  return String(value)
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/gu, " ")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/\]\(\s*/gu, " ")
    .replace(/^\s*\{[^}]+\}\s*$/gmu, " ")
    .replace(/[#>*_`~|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function extractExplicitDate(value) {
  const chinese = value.match(
    /((?:18|19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u,
  );
  if (chinese) {
    return {
      date: `${chinese[1]}-${pad(chinese[2])}-${pad(chinese[3])}`,
      precision: "day",
    };
  }
  const iso = value.match(/((?:18|19|20)\d{2})-(\d{1,2})-(\d{1,2})/u);
  if (iso) {
    return {
      date: `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`,
      precision: "day",
    };
  }
  const year = value.match(/((?:18|19|20)\d{2})\s*年/u);
  if (year) return { date: `${year[1]}-01-01`, precision: "year" };
  return null;
}

export function normalizeIdentifier(value) {
  return String(value)
    .replace(/\s+/gu, "")
    .replace(/[《》“”"'（）()_-]/gu, "")
    .toLocaleLowerCase("zh-CN");
}

function segmentNews(
  repositoryPath,
  lines,
  sourceTitle,
  description,
  override,
  attributeLocations,
) {
  if (override?.exclude === true) {
    return {
      strategy: "excluded",
      confidence: 1,
      candidateBoundaryCount: 0,
      reviewReasons: [],
      sections: [],
    };
  }
  if (override?.singleNews === true) {
    return fallbackSegment(
      lines,
      sourceTitle,
      description,
      "manual_single",
      1,
      [],
    );
  }
  if (Array.isArray(override?.boundaryMarkers)) {
    return markerSegments(lines, override.boundaryMarkers, sourceTitle);
  }
  if (repositoryPath.startsWith("daily/")) {
    return numberedHeadingSegments(
      lines,
      sourceTitle,
      "daily_numbered_heading",
      true,
    );
  }
  if (repositoryPath.startsWith("reference/")) {
    const numbered = numberedHeadingSegments(
      lines,
      sourceTitle,
      "reference_numbered_heading",
      true,
    );
    if (!numbered.fallback) return numbered;
    const descriptionSegments = metadataDescriptionSegments(
      description,
      attributeLocations?.description,
    );
    if (descriptionSegments.sections.length > 1) return descriptionSegments;
    return numbered;
  }
  if (repositoryPath.startsWith("main/")) {
    const interview = interviewSegments(lines, sourceTitle);
    if (interview.sections.length > 1) return interview;
    const horizontal = horizontalRuleSegments(lines, sourceTitle);
    if (horizontal.sections.length > 1) return horizontal;
    const reviewReasons = [];
    if (
      /睡前消息/u.test(sourceTitle) &&
      cleanText(lines.join("\n")).length >= 4_000
    ) {
      reviewReasons.push("long_main_page_without_confident_boundaries");
    }
    if (interview.candidateBoundaryCount >= 4) {
      reviewReasons.push("interview_prompts_found_but_grouped_as_one_news");
    }
    return fallbackSegment(
      lines,
      sourceTitle,
      description,
      "page_fallback",
      0.55,
      reviewReasons,
    );
  }
  const horizontal = horizontalRuleSegments(lines, sourceTitle);
  if (horizontal.sections.length > 1) return horizontal;
  return fallbackSegment(
    lines,
    sourceTitle,
    description,
    "page_fallback",
    0.8,
    [],
  );
}

function markerSegments(lines, markers, sourceTitle) {
  const starts = [];
  for (const marker of markers) {
    const index = lines.findIndex((line) => cleanText(line).includes(marker));
    if (index === -1) {
      throw new Error(
        `Manual news boundary marker not found in ${sourceTitle}: ${marker}`,
      );
    }
    starts.push({ index, title: cleanText(lines[index]), marker });
  }
  starts.sort((left, right) => left.index - right.index);
  return segmentsFromStarts(
    lines,
    starts,
    "manual_markers",
    1,
    markers.length,
    [],
  );
}

function numberedHeadingSegments(lines, sourceTitle, strategy, strict) {
  const starts = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(NUMBERED_HEADING);
    if (!match || MEDIA_HEADING.test(cleanText(match[1]))) continue;
    starts.push({
      index,
      title: cleanText(match[1]),
      marker: cleanText(line),
    });
  }
  if (!starts.length) {
    const reasons = strict ? ["numbered_news_headings_not_found"] : [];
    return {
      ...fallbackSegment(
        lines,
        sourceTitle,
        "",
        "page_fallback",
        strict ? 0.45 : 0.8,
        reasons,
      ),
      fallback: true,
    };
  }
  return segmentsFromStarts(
    lines,
    starts,
    strategy,
    1,
    starts.length,
    [],
  );
}

function interviewSegments(lines, sourceTitle) {
  const prompts = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(INTERVIEW_PROMPT);
    if (!match) continue;
    const text = cleanText(match[1]);
    if (!text || MEDIA_HEADING.test(text)) continue;
    prompts.push({ index, text });
  }
  if (!prompts.length) {
    return {
      strategy: "main_interview_topic",
      confidence: 0,
      candidateBoundaryCount: 0,
      reviewReasons: [],
      sections: [],
    };
  }

  const starts = [];
  let currentTitle = "";
  for (const [promptIndex, prompt] of prompts.entries()) {
    const isBoundary =
      promptIndex === 0 || isLikelyTopicIntroduction(prompt.text, currentTitle);
    if (!isBoundary) continue;
    currentTitle = prompt.text;
    starts.push({
      index: prompt.index,
      title: promptTitle(prompt.text, sourceTitle),
      marker: prompt.text,
    });
  }
  return segmentsFromStarts(
    lines,
    starts,
    "main_interview_topic",
    starts.length > 1 ? 0.88 : 0.5,
    prompts.length,
    [],
  );
}

function isLikelyTopicIntroduction(text, currentTitle) {
  let score = 0;
  if (EXPLICIT_TRANSITION.test(text)) score += 5;
  if (DATE_LEAD.test(text)) score += 4;
  if (REPORTING_LANGUAGE.test(text)) score += 2;
  if (text.length >= 55) score += 1;
  if (FOLLOW_UP_LEAD.test(text)) score -= 5;
  if (hasDistinctiveOverlap(text, currentTitle)) score -= 4;
  return score >= 4;
}

function hasDistinctiveOverlap(left, right) {
  if (!left || !right) return false;
  const leftNgrams = hanNgrams(left);
  const rightNgrams = hanNgrams(right);
  for (const value of leftNgrams) {
    if (rightNgrams.has(value)) return true;
  }
  return false;
}

function hanNgrams(value) {
  const normalized = value.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "");
  const result = new Set();
  for (let index = 0; index < normalized.length - 2; index += 1) {
    const ngram = normalized.slice(index, index + 3);
    if (
      !/^(?:这件事|这一次|为什么|怎么办|你觉得|你认为|怎么看|督工你|新闻里|消息说|我们看|接下来)$/u.test(
        ngram,
      )
    ) {
      result.add(ngram);
    }
  }
  return result;
}

function horizontalRuleSegments(lines, sourceTitle) {
  const delimiters = lines
    .map((line, index) => (/^\s*---\s*$/u.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (!delimiters.length) {
    return {
      strategy: "horizontal_rule",
      confidence: 0,
      candidateBoundaryCount: 0,
      reviewReasons: [],
      sections: [],
    };
  }
  const ranges = [];
  let start = 0;
  for (const delimiter of delimiters) {
    ranges.push([start, delimiter]);
    start = delimiter + 1;
  }
  ranges.push([start, lines.length]);
  const sections = ranges
    .filter(([rangeStart, rangeEnd]) => {
      const text = cleanText(lines.slice(rangeStart, rangeEnd).join("\n"));
      return text.length >= 100 && !isMediaBlock(text);
    })
    .map(([rangeStart, rangeEnd], index) => {
      const raw = lines.slice(rangeStart, rangeEnd).join("\n");
      return {
        start: rangeStart,
        end: rangeEnd,
        title:
          index === 0
            ? sourceTitle
            : sectionTitle(raw) || `${sourceTitle} · ${index + 1}`,
        summary: meaningfulParagraph(raw),
        marker: sectionTitle(raw) || firstSentence(cleanText(raw)),
      };
    });
  return {
    strategy: "horizontal_rule",
    confidence: sections.length > 1 ? 0.82 : 0,
    candidateBoundaryCount: delimiters.length,
    reviewReasons: [],
    sections,
  };
}

function fallbackSegment(
  lines,
  sourceTitle,
  description,
  strategy,
  confidence,
  reviewReasons,
) {
  return {
    strategy,
    confidence,
    candidateBoundaryCount: 0,
    reviewReasons,
    sections: [
      {
        start: 0,
        end: lines.length,
        title: sourceTitle,
        summary: description || meaningfulParagraph(lines.join("\n")),
        marker: "page",
      },
    ],
  };
}

function metadataDescriptionSegments(description, location) {
  if (!description || !location) {
    return {
      strategy: "reference_description_sentence",
      confidence: 0,
      candidateBoundaryCount: 0,
      reviewReasons: [],
      sections: [],
    };
  }
  const sentences = [];
  for (const match of description.matchAll(/[^。！？!?]+[。！？!?]?/gu)) {
    const text = match[0].trim();
    if (text.length < 8) continue;
    const offset = description.indexOf(text, match.index ?? 0);
    sentences.push({
      start: 0,
      end: 0,
      title: text.replace(/[。！？!?]+$/gu, "").slice(0, 160),
      summary: text,
      marker: text,
      sourceField: "frontmatter.description",
      metadataText: text,
      metadataLine: location.line,
      startColumn: location.valueStartColumn + offset,
      endColumn: location.valueStartColumn + offset + text.length - 1,
    });
  }
  return {
    strategy: "reference_description_sentence",
    confidence: sentences.length > 1 ? 0.76 : 0,
    candidateBoundaryCount: sentences.length,
    reviewReasons:
      sentences.length > 1 ? ["metadata_only_news_segmentation"] : [],
    sections: sentences,
  };
}

function segmentsFromStarts(
  lines,
  starts,
  strategy,
  confidence,
  candidateBoundaryCount,
  reviewReasons,
) {
  const sections = starts
    .map((start, index) => {
      const end = starts[index + 1]?.index ?? lines.length;
      const raw = lines.slice(start.index, end).join("\n");
      return {
        start: start.index,
        end,
        title: start.title,
        summary: meaningfulParagraph(raw),
        marker: start.marker,
      };
    })
    .filter((section) => cleanText(lines.slice(section.start, section.end).join("\n")).length >= 40);
  return {
    strategy,
    confidence,
    candidateBoundaryCount,
    reviewReasons,
    sections,
  };
}

function promptTitle(text, sourceTitle) {
  const cleaned = text
    .replace(
      /^(?:接下来|下面|再来看看|再看|最后|另外|另一个|还有|下一条|下一则)\s*(?:我们)?\s*(?:来)?\s*(?:看看)?\s*(?:国际|国内)?\s*(?:新闻|消息)?[，。：:\s]*/u,
      "",
    )
    .replace(/^(?:督工|马督工)[，,：:\s]*/u, "");
  const sentence = firstSentence(cleaned);
  return (sentence.length >= 8 ? sentence : cleaned || sourceTitle).slice(0, 160);
}

function sectionTitle(segment) {
  const fontPrompt = segment.match(INTERVIEW_PROMPT)?.[1];
  const heading = Array.from(segment.matchAll(/^#{1,3}\s+(.+)$/gmu))
    .map((match) => cleanText(match[1]))
    .find((value) => value && !MEDIA_HEADING.test(value));
  const candidate = cleanText(
    fontPrompt || heading || meaningfulParagraph(segment),
  );
  return firstSentence(candidate).slice(0, 90);
}

function parseFrontMatter(raw) {
  const lines = raw.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") {
    return {
      attributes: {},
      attributeLocations: {},
      body: raw,
      bodyLines: lines,
      bodyStartLine: 1,
    };
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (closingIndex === -1) {
    return {
      attributes: {},
      attributeLocations: {},
      body: raw,
      bodyLines: lines,
      bodyStartLine: 1,
    };
  }
  const attributes = {};
  const attributeLocations = {};
  lines.slice(1, closingIndex).forEach((line, index) => {
    const separator = line.indexOf(":");
    if (separator === -1) return;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1);
    const leadingWhitespace = rawValue.length - rawValue.trimStart().length;
    const trimmedValue = rawValue.trim();
    const quoteOffset = /^['"]/u.test(trimmedValue) ? 1 : 0;
    const value = trimmedValue.replace(/^['"]|['"]$/gu, "");
    attributes[key] = value;
    attributeLocations[key] = {
      line: index + 2,
      valueStartColumn: separator + 2 + leadingWhitespace + quoteOffset,
    };
  });
  const bodyLines = lines.slice(closingIndex + 1);
  return {
    attributes,
    attributeLocations,
    body: bodyLines.join("\n"),
    bodyLines,
    bodyStartLine: closingIndex + 2,
  };
}

function isNavigationIndex(body) {
  const linkItems =
    body.match(/^\s*-\s+\[[^\]]+\]\([^)]+\.md\)/gmu)?.length ?? 0;
  if (linkItems < 5) return false;
  const proseLines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length >= 80 &&
        !/^[-#<{[]/u.test(line) &&
        !/^\[[^\]]+\]\([^)]+\)$/u.test(line),
    );
  return proseLines.length === 0;
}

function isMediaBlock(value) {
  return /^(?:Tabs\s*)?(?:B站|西瓜视频|YouTube|播客|\s)*$/iu.test(value);
}

function firstHeading(body) {
  return body.match(/^#{1,3}\s+(.+)$/mu)?.[1];
}

function meaningfulParagraph(body) {
  return (
    body
      .split(/\n\s*\n/u)
      .map(cleanText)
      .find(
        (paragraph) =>
          paragraph.length >= 30 &&
          !/^(?:Tabs|B站|西瓜视频|YouTube|播客|以下文本为)/iu.test(
            paragraph,
          ),
      ) ?? cleanText(body)
  );
}

function firstSentence(value) {
  return value.split(/[。！？!?；;]/u)[0]?.trim() ?? value;
}

function extractDate(repositoryPath, body, attributes) {
  const pathDate = repositoryPath.match(
    /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})\.md$/u,
  );
  if (pathDate) {
    return {
      date: `${pathDate[1]}-${pathDate[2]}-${pathDate[3]}`,
      source: "repository_path",
    };
  }
  const editionDate = extractEditionDate(body);
  if (editionDate) return { date: editionDate, source: "episode_preamble" };
  const titleDate = normalizeIsoDate(attributes.title);
  if (titleDate) return { date: titleDate, source: "page_title" };
  const frontmatterDate = normalizeIsoDate(
    attributes.dateCreated || attributes.date,
  );
  if (frontmatterDate) {
    return { date: frontmatterDate, source: "frontmatter" };
  }
  return { date: "1900-01-01", source: "unknown" };
}

function extractEditionDate(body) {
  const preamble = body.slice(0, 5_000);
  const compact = preamble.match(
    /睡前消息\s*[：:]\s*(\d{2,4})\s*[/.年-]\s*(\d{1,2})\s*[/.月-]\s*(\d{1,2})\s*日?/u,
  );
  if (compact) {
    const numericYear = Number(compact[1]);
    const year =
      compact[1].length === 2
        ? numericYear >= 70
          ? 1900 + numericYear
          : 2000 + numericYear
        : numericYear;
    return `${year}-${pad(compact[2])}-${pad(compact[3])}`;
  }
  const spoken = preamble.match(
    /大家好[，,\s]*(?:今天是)?\s*((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u,
  );
  if (spoken) {
    return `${spoken[1]}-${pad(spoken[2])}-${pad(spoken[3])}`;
  }
  return null;
}

function normalizeIsoDate(value) {
  return value?.match(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?:[^\d]|$)/u)?.[1];
}

function extractEpisode(title) {
  const match = String(title).match(
    /【\s*睡前消息\s*(\d+(?:\.\d+)?)\s*】/u,
  );
  if (!match) return null;
  return {
    series: "bedtimenews",
    number: Number(match[1]),
  };
}

function longestNondecreasingDateSequence(pages) {
  if (!pages.length) return [];
  const lengths = pages.map(() => 1);
  const previous = pages.map(() => -1);
  let bestIndex = 0;
  for (let index = 0; index < pages.length; index += 1) {
    for (let candidate = 0; candidate < index; candidate += 1) {
      if (
        pages[candidate].publishedAt <= pages[index].publishedAt &&
        lengths[candidate] + 1 > lengths[index]
      ) {
        lengths[index] = lengths[candidate] + 1;
        previous[index] = candidate;
      }
    }
    if (lengths[index] >= lengths[bestIndex]) bestIndex = index;
  }
  const retained = [];
  for (let index = bestIndex; index >= 0; index = previous[index]) {
    retained.push(pages[index]);
    if (previous[index] === -1) break;
  }
  return retained.reverse();
}

function findAnchor(anchors, episodeNumber, direction) {
  if (direction === "previous") {
    for (let index = anchors.length - 1; index >= 0; index -= 1) {
      if (anchors[index].episode.number < episodeNumber) return anchors[index];
    }
    return null;
  }
  return (
    anchors.find((page) => page.episode.number > episodeNumber) ?? null
  );
}

function interpolateEpisodeDate(previous, next, page) {
  const range = next.episode.number - previous.episode.number;
  const position = page.episode.number - previous.episode.number;
  const start = isoDateToDay(previous.publishedAt);
  const end = isoDateToDay(next.publishedAt);
  return dayToIsoDate(start + Math.round(((end - start) * position) / range));
}

function offsetEpisodeDate(anchor, page, daysPerEpisode) {
  const episodeOffset = page.episode.number - anchor.episode.number;
  return dayToIsoDate(
    isoDateToDay(anchor.publishedAt) +
      Math.round(episodeOffset * daysPerEpisode),
  );
}

function medianEpisodeInterval(anchors) {
  const intervals = [];
  for (let index = 1; index < anchors.length; index += 1) {
    const episodeGap =
      anchors[index].episode.number - anchors[index - 1].episode.number;
    const dayGap =
      isoDateToDay(anchors[index].publishedAt) -
      isoDateToDay(anchors[index - 1].publishedAt);
    const interval = dayGap / episodeGap;
    if (interval > 0 && interval <= 14) intervals.push(interval);
  }
  if (!intervals.length) return 2;
  intervals.sort((left, right) => left - right);
  const middle = Math.floor(intervals.length / 2);
  return intervals.length % 2
    ? intervals[middle]
    : (intervals[middle - 1] + intervals[middle]) / 2;
}

function isoDateToDay(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function dayToIsoDate(value) {
  return new Date(value * 86_400_000).toISOString().slice(0, 10);
}

function datePrecision(date) {
  return date.endsWith("-01-01") ? "year" : "day";
}

function pageKind(repositoryPath) {
  const root = repositoryPath.split("/", 1)[0];
  return root === "main" ? "episode" : root;
}

function archiveUrl(repositoryPath) {
  return `https://archive.bedtime.news/zh/${repositoryPath.replace(/\.md$/u, "")}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function uniqueIds(records, path, issues) {
  const ids = new Set();
  records.forEach((record, index) => {
    if (!record.id) issues.push(issue(`${path}.${index}.id`, "missing ID"));
    else if (ids.has(record.id)) {
      issues.push(issue(`${path}.${index}.id`, `duplicate ID ${record.id}`));
    }
    ids.add(record.id);
  });
  return ids;
}

function issue(path, message) {
  return { level: "error", path, message };
}

function shortHash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
