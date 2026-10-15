import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

const basePath = process.env.PLAYWRIGHT_BASE_PATH ?? "";
const home = `${basePath}/`;
const bodyNewsId = "news-9a8699b5b824";

test("reading entries and graph controls have at least 44px touch targets", async ({ page }) => {
  const checkTargets = async (selector: string) => {
    const targets = page.locator(selector).filter({ visible: true });
    expect(await targets.count()).toBeGreaterThan(0);
    for (const target of await targets.all()) {
      const box = (await target.boundingBox())!;
      expect(box.height, `target height: ${await target.textContent()}`).toBeGreaterThanOrEqual(44);
      expect(box.width, `target width: ${await target.textContent()}`).toBeGreaterThanOrEqual(44);
    }
  };
  await page.goto(home);
  await expect(page.locator(".result-card")).toHaveCount(20);
  await checkTargets(".result-link,.card-evidence>summary");
  await page.locator(".news-title-link").first().click();
  await expect(page.locator(".reading-panel h1")).toBeVisible();
  await checkTargets(".reading-toolbar button,.reading-panel .reading-actions a,.reading-panel .reading-actions button,.reading-panel .reading-evidence>summary");
  await page.keyboard.press("Escape");
  await page.goto(`${basePath}/graph/?entity=entity-organization-f8be44d48cf6`);
  await expect(page.locator(".entity-profile h1")).toHaveText("华为");
  await checkTargets(".entity-profile>button");
  if (page.viewportSize()!.width <= 900) {
    await checkTargets(".entity-profile>.graph-mobile-toggle");
    await page.getByRole("button", { name: "展开关系图谱", exact: true }).click();
  }
  await expect(page.getByTestId("knowledge-graph-canvas")).toBeVisible();
  await checkTargets(".graph-toolbar button,.graph-branch-actions button");
});

test("keyboard reading restores focus and scroll, with a modal only below 1100px", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(home);
  await expect(page.locator(".result-card")).toHaveCount(20);
  await expect(page.locator("#keyword")).not.toBeFocused();
  const title = page.locator(".news-title-link").nth(3);
  await title.scrollIntoViewIfNeeded(); const scrollY = await page.evaluate(() => window.scrollY);
  await title.press("Enter");
  const heading = page.locator(".reading-panel h1"); await expect(heading).toBeFocused();
  const mobile = page.viewportSize()!.width < 1100;
  await expect(page.locator(".reading-panel")).toHaveAttribute("role", mobile ? "dialog" : "region");
  if (mobile) {
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    expect(await page.locator("[inert]").count()).toBe(1);
    await page.locator(".reading-panel").locator("a[href],button:not([disabled]),summary").filter({ visible: true }).last().focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "← 返回", exact: true })).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(page.locator(".reading-panel")).toHaveCount(0); await expect(title).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(scrollY, 0);
  await page.goto(`${home}?news=${bodyNewsId}`);
  await expect(page.locator(".reading-prose")).toBeVisible();
  await page.screenshot({ path: resolve(`outputs/ux-review/reading-${info.project.name}.png`) });
});

test("a genuine canonical news link opens a new tab with the Pages prefix", async ({ page, context }) => {
  await page.goto(home); const title = page.locator(".news-title-link").first();
  const href = (await title.getAttribute("href"))!; expect(href).toMatch(new RegExp(`^${basePath}/news/news-`));
  const popupReady = context.waitForEvent("page"); await title.click({ modifiers: ["ControlOrMeta"] });
  const popup = await popupReady; await popup.waitForLoadState();
  await expect(popup).toHaveURL(new RegExp(`${basePath}/news/news-[a-z0-9]+/`));
  await expect(popup.locator(".standalone-article [data-news-id]")).toBeVisible();
  await expect(page.locator(".reading-panel")).toHaveCount(0); await popup.close();
});

test("summary-only archives, entity inspection and nested back give honest context", async ({ page }) => {
  await page.goto(home); await page.locator(".news-summary-link").first().click();
  await expect(page.locator(".reading-panel")).toContainText("当前归档仅提供摘要");
  const newsUrl = page.url(); await page.locator(".reading-panel .entity-tags button").first().click();
  await expect(page.locator(".entity-reading h1")).toBeVisible();
  const related = page.locator(".entity-reading .reading-related>a"); expect(await related.count()).toBeGreaterThan(0);
  expect(await related.first().getAttribute("href")).toMatch(new RegExp(`^${basePath}/news/`));
  await page.getByRole("button", { name: "← 返回", exact: true }).click(); await expect(page).toHaveURL(newsUrl);
  await expect(page.locator(".reading-panel .news-reading")).toBeVisible();
  await expect(page.locator(".reading-panel h1")).toBeFocused();
  await page.getByRole("button", { name: "关闭阅读面板" }).click(); await expect(page.locator(".reading-panel")).toHaveCount(0);
});

test("marking unread survives a reload and clearing history clears only read records", async ({ page }) => {
  await page.goto(home); await page.locator(".news-title-link").first().click();
  await page.getByRole("button", { name: "标记未读", exact: true }).click();
  await expect(page.getByRole("button", { name: "标记已读", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.locator(".result-card .read-badge")).toHaveCount(0);
  await page.reload(); await expect(page.locator(".result-card .read-badge")).toHaveCount(0);
  await page.locator(".news-title-link").first().click(); await expect(page.getByRole("button", { name: "标记未读", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.locator(".result-card .read-badge")).toHaveCount(1);
  await page.getByRole("button", { name: "清除已读记录", exact: true }).click();
  await page.getByRole("button", { name: "确认清除", exact: true }).click();
  await expect(page.locator(".result-card .read-badge")).toHaveCount(0);
  const memory = await page.evaluate(() => JSON.parse(localStorage.getItem("history-atlas-reading-v1")!));
  expect(memory.knownNewsIds.length).toBeGreaterThan(9000); expect(memory.read).toEqual({});
});

test("return-visit notices keep one session baseline across pages and changed bodies become unread", async ({ page }) => {
  const catalogReady = page.waitForResponse((response) => /\/reading\/.+\/catalog\.json$/.test(response.url()));
  await page.goto(home); const catalog = await (await catalogReady).json();
  const first = (await page.locator(".news-title-link").first().getAttribute("href"))!.split("/").filter(Boolean).at(-1)!;
  await page.evaluate(({ catalog, first }) => {
    sessionStorage.clear();
    localStorage.setItem("history-atlas-reading-v1", JSON.stringify({ version: 1, read: { [first]: "0".repeat(64) }, knownNewsIds: catalog.updates.knownNewsIds.filter((id: string) => id !== first), releaseId: "previous" }));
  }, { catalog, first });
  await page.reload(); await expect(page.locator(".reading-update-count")).toHaveText("上次访问后新增 1 条");
  await expect(page.locator(".result-card").first().locator(".read-badge")).toHaveCount(0);
  await expect(page.locator(".result-card").first().locator(".new-badge")).toHaveText("新收录");
  await page.getByRole("navigation", { name: "主要导航", exact: true }).getByRole("link", { name: "知识分类", exact: true }).click();
  await expect(page.locator(".knowledge-directory")).toBeVisible();
  await page.getByRole("link", { name: "返回检索", exact: true }).click();
  await expect(page.locator(".reading-update-count")).toHaveText("上次访问后新增 1 条");
  await page.evaluate(() => sessionStorage.clear()); await page.reload();
  await expect(page.locator(".reading-update-count")).toHaveText("上次访问后暂无新增");
});

test("blocked storage still allows complete reading and return", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("storage disabled"); } });
    Object.defineProperty(window, "sessionStorage", { get() { throw new Error("storage disabled"); } });
  });
  await page.goto(home); await page.locator(".news-title-link").first().click();
  await expect(page.locator(".reading-panel .reading-prose")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.locator(".reading-panel")).toHaveCount(0);
  await expect(page.locator(".result-card")).toHaveCount(20);
});

test("a return visit without an update index does not claim there are no new stories", async ({ page }) => {
  await page.goto(home);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("history-atlas-reading-v1") ?? "null")?.knownNewsIds?.length ?? 0)).toBeGreaterThan(0);
  await page.evaluate(() => sessionStorage.clear());
  await page.route("**/reading/**/catalog.json", async (route) => {
    const response = await route.fetch(); const catalog = await response.json();
    catalog.recorded = false;
    await route.fulfill({ response, json: catalog });
  });
  await page.reload();
  await expect(page.locator(".reading-update-count")).toHaveText("本版本更新信息未记录");
  await expect(page.locator(".result-card .new-badge")).toHaveCount(0);
  await page.locator(".news-title-link").first().click();
  await expect(page.locator(".reading-panel h1")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".reading-update-count")).toHaveText("本版本更新信息未记录");
  await page.unrouteAll({ behavior: "wait" });
});

test("archive image errors provide an original-image link and relative links have safe URLs", async ({ page }) => {
  await page.route("**/reading/**/news/*.json", async (route) => {
    const response = await route.fetch(); const article = await response.json();
    article.contentStatus = "body";
    article.markdown = '[相对链接](../related.md)\n\n![新闻配图](https://archive.bedtime.news/__missing-qa-image.png)';
    await route.fulfill({ response, json: article });
  });
  await page.route("https://archive.bedtime.news/__missing-qa-image.png", (route) => route.abort());
  await page.goto(home); await page.locator(".news-title-link").first().click();
  await expect(page.locator(".image-fallback")).toContainText("图片暂时无法显示");
  await expect(page.locator(".image-fallback")).toHaveAttribute("href", "https://archive.bedtime.news/__missing-qa-image.png");
  await expect(page.getByRole("link", { name: "相对链接", exact: true })).toHaveAttribute("href", /^https:\/\/archive\.bedtime\.news\//);
  await page.unrouteAll({ behavior: "wait" });
});

test("knowledge category searches and pages share their URL and survive entity inspection", async ({ page }) => {
  await page.goto(`${basePath}/ontology/`);
  await expect(page.locator(".directory-list>button")).toHaveCount(20);
  const pager = page.getByRole("navigation", { name: "知识分类分页", exact: true });
  await pager.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/); const url = page.url();
  const entity = page.locator(".directory-list>button").first(); const name = await entity.locator("strong").textContent();
  await entity.click(); await expect(page.locator(".entity-reading h1")).toHaveText(name!);
  await page.keyboard.press("Escape"); await expect(page).toHaveURL(url); await expect(entity).toBeFocused();
  await page.reload(); await expect(pager).toContainText("2 /");
  await page.locator("#directory-search").fill("武汉"); await expect(page).toHaveURL(/q=/);
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  await expect(page.locator(".directory-list>button").first()).toContainText("武汉");
  await expect(page.locator(".ontology-professional")).not.toHaveAttribute("open");
});

test("no new entities provides recent-report entities without claiming they were newly introduced", async ({ page }) => {
  await page.goto(home); await page.getByRole("button", { name: "新实体", exact: true }).click();
  await expect(page.locator(".entity-update-note")).toContainText("本版本没有新增或恢复的实体");
  await expect(page.locator(".results-section")).toContainText("近期有新报道");
  const entities = page.locator(".entity-result-card"); expect(await entities.count()).toBeGreaterThan(0); expect(await entities.count()).toBeLessThanOrEqual(20);
  await entities.first().click(); await expect(page.locator(".entity-reading h1")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page).toHaveURL(/feed=entities/);
});

test("related reading starts at the heading and returning restores the previous article position", async ({ page }) => {
  await page.goto(`${home}?news=${bodyNewsId}`);
  const pane = page.locator(".reading-panel-scroll");
  await expect(page.locator(`.reading-panel [data-news-id='${bodyNewsId}']`)).toBeVisible();
  const heading = page.locator(".reading-panel [data-reading-heading]"); await expect(heading).toBeFocused();
  await expect(page.locator(".reading-panel .reading-prose")).not.toContainText("Tabs {.tabset}");
  const related = page.locator(".reading-panel .reading-related>a").first();
  await related.scrollIntoViewIfNeeded();
  const previousTop = await pane.evaluate((element) => element.scrollTop); expect(previousTop).toBeGreaterThan(100);
  const oldTitle = await heading.textContent();
  await related.click(); await expect(heading).not.toHaveText(oldTitle!);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "← 返回", exact: true }).click();
  await expect(heading).toHaveText(oldTitle!); await expect(heading).toBeFocused();
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeCloseTo(previousTop, 0);
});

test("entity reader pagination survives reading news and returning to the exact list position", async ({ page }) => {
  await page.goto(`${home}?inspectEntity=entity-organization-f8be44d48cf6`);
  const pager = page.getByRole("navigation", { name: "实体相关新闻分页", exact: true });
  await expect(page.locator(".entity-reading .reading-related>a")).toHaveCount(20);
  await pager.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/inspectPage=2/); await expect(pager).toContainText("2 /");
  const related = page.locator(".entity-reading .reading-related>a").nth(15);
  const title = await related.locator("strong").textContent(); await related.scrollIntoViewIfNeeded();
  const top = await page.locator(".reading-panel-scroll").evaluate((element) => element.scrollTop);
  await related.click(); await expect(page.locator(".reading-panel h1")).toHaveText(title!);
  await page.getByRole("button", { name: "← 返回", exact: true }).click();
  await expect(page.locator(".entity-reading h1")).toHaveText("华为");
  await expect(pager).toContainText("2 /"); await expect(page).toHaveURL(/inspectPage=2/);
  await expect.poll(() => page.locator(".reading-panel-scroll").evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
});

test("video-only archives provide an honest notice and a safe original-platform link", async ({ page }) => {
  await page.goto(`${home}?news=news-fa2721d580ba`);
  await expect(page.locator(".reading-panel")).toContainText("当前归档片段仅保存视频，没有文字正文");
  await expect(page.locator(".reading-media-links a")).toHaveAttribute("href", /^https:\/\/(?:player|www)\.bilibili\.com\//);
  await expect(page.locator(".reading-panel iframe")).toHaveCount(0);
});
