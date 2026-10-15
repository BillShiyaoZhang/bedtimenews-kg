import assert from "node:assert/strict";
import test from "node:test";
import { archiveMedia } from "../app/lib/archive-media.mjs";
test("video-only archive navigation has a usable platform link while prose remains prose", () => {
  const frame = '<iframe src="https://player.bilibili.com/player.html?bvid=BV123ab&amp;page=1"></iframe>';
  const media = archiveMedia(`# Tabs {.tabset}\n\nB站\n${frame}`);
  assert.equal(media.videoOnly, true); assert.equal(media.links[0].href, "https://www.bilibili.com/video/BV123ab/");
  assert.equal(archiveMedia(`# Tabs {.tabset}\n\n## B站\n<div>${frame}</div>\n\n#`).videoOnly, true);
  assert.equal(archiveMedia(`完整新闻正文。\n${frame}`).videoOnly, false);
  const mixed = archiveMedia(`# Tabs {.tabset}\n\n## B站\n${frame}\n\n完整新闻正文。`);
  assert.equal(mixed.videoOnly, false); assert.doesNotMatch(mixed.markdown, /Tabs|tabset|B站|iframe/u);
  assert.match(mixed.markdown, /完整新闻正文。/u);
  assert.equal(archiveMedia("这是一段没有视频的归档正文").videoOnly, false);
});
test("comments, script URLs and embedded credentials cannot become video links", () => {
  assert.deepEqual(archiveMedia('<!--<iframe src="https://example.com/"></iframe>--><iframe src="javascript:alert(1)"></iframe><iframe src="https://user:password@example.com/"></iframe>').links, []);
  const media = archiveMedia('<iframe src="https://www.youtube-nocookie.com/embed/abc-123"></iframe>');
  assert.equal(media.links[0].href, "https://www.youtube.com/watch?v=abc-123"); assert.equal(media.videoOnly, true);
});
