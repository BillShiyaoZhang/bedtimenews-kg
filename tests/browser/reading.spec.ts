import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const seed = "entity-organization-f8be44d48cf6";
const topic = "entity-topic-8a581a8f5d03";
const governance = "entity-topic-ba1dbbad6e64";
const basePath = process.env.PLAYWRIGHT_BASE_PATH ?? "";
test("first visit offers search and real news within the first screen", async ({ page }, info) => {
  await page.goto(`${basePath}/`); await expect(page.locator(".result-card")).toHaveCount(20);
  const title = page.locator(".news-title-link").first(); await expect(title).toBeVisible();
  const titleBox = (await title.boundingBox())!;
  expect(titleBox.y + titleBox.height).toBeLessThan(page.viewportSize()!.height - 8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await mkdir(resolve("outputs/ux-review"), { recursive: true });
  await page.screenshot({ path: resolve(`outputs/ux-review/home-${info.project.name}.png`) });
});
test("reading and browser back preserve an unsubmitted search draft and focus", async ({ page }) => {
  await page.goto(`${basePath}/`); await page.locator("#keyword").fill("准备稍后搜索");
  const title = page.locator(".news-title-link").first(); const text = await title.textContent(); await title.click();
  await expect(page.locator(".reading-panel h1")).toHaveText(text!);
  await expect(page.locator(".reading-panel .reading-evidence")).not.toHaveAttribute("open");
  await page.goBack(); await expect(page.locator(".reading-panel")).toHaveCount(0);
  await expect(page.locator("#keyword")).toHaveValue("准备稍后搜索"); await expect(title).toBeFocused();
});
test("search and pagination remain available beyond the old result limit", async ({ page }) => {
  await page.goto(`${basePath}/`); await page.locator("#keyword").fill("武汉"); await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL(/q=/); await expect(page.locator(".result-card")).toHaveCount(20);
  await page.getByRole("navigation", { name: "结果分页" }).getByRole("button", { name: "下一页" }).click();
  await expect(page).toHaveURL(/page=2/); const url = page.url();
  await page.locator(".news-title-link").first().click(); await expect(page.locator(".reading-panel h1")).toBeVisible();
  await page.getByRole("button", { name: "关闭阅读面板" }).click(); await expect(page).toHaveURL(url);
  await expect(page.locator("#keyword")).toHaveValue("武汉");
});
test("unknown and malformed IDs remain readable errors instead of loading other assets", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${basePath}/?news=..%2Fcatalog`); await expect(page.locator(".reading-panel")).toContainText("未找到这条记录");
  await page.getByRole("button", { name: "关闭阅读面板" }).click(); await expect(page.locator(".reading-panel")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("shared reader handles retry, independent URLs and safe archive formatting", async ({ page }) => {
  await page.goto(`${basePath}/`); const anchor = page.locator(".news-title-link").first(); const href = (await anchor.getAttribute("href"))!;
  let fail = true;
  await page.route("**/reading/**/news/*.json", async (route) => {
    if (fail) { fail = false; await route.fulfill({ status: 503, body: "offline" }); return; }
    const response = await route.fetch(); const article = await response.json();
    article.contentStatus = "body"; article.markdown = "完整新闻片段\n\n| 标题 | 数值 |\n| --- | --- |\n| 原文 | 3 |\n\n<!--隐藏备注--><script>window.unsafeArchive=1</script><a href=\"javascript:alert(1)\">危险链接</a>";
    await route.fulfill({ response, json: article });
  });
  await anchor.click(); await expect(page.locator(".reading-panel")).toContainText("暂时无法加载内容");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".reading-prose table")).toBeVisible(); await expect(page.locator(".reading-prose")).not.toContainText("隐藏备注");
  expect(await page.locator(".reading-prose script").count()).toBe(0); expect(await page.locator('.reading-prose a[href^="javascript:"]').count()).toBe(0);
  await page.getByRole("button", { name: "关闭阅读面板" }).click(); await page.goto(href); await expect(page.locator(".standalone-article [data-news-id]")).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
});
test("SVG exploration keeps nodes and supports keyboard, undo and reading", async ({ page }, info) => {
  await page.goto(`${basePath}/graph/?entity=${seed}`);
  if (page.viewportSize()!.width < 900) await page.getByRole("button", { name: "展开关系图谱", exact: true }).click();
  const graph = page.getByTestId("knowledge-graph-canvas"); await expect(graph).toBeVisible();
  const root = graph.locator(`[data-node="${seed}"]`); const position = await root.getAttribute("transform");
  await graph.locator(`[data-node="${topic}"]`).press("Enter"); await expect(page).toHaveURL(new RegExp(`focus=${topic}`));
  await graph.locator(`[data-node="${governance}"]`).press("Enter"); await expect(page).toHaveURL(new RegExp(`focus=${governance}`));
  await expect(root).toHaveAttribute("transform", position!);
  await page.getByRole("button", { name: "撤销上一步", exact: true }).click(); await expect(page).toHaveURL(new RegExp(`focus=${topic}`));
  if (info.project.name === "desktop") {
    await graph.locator('[data-kind="event"]').first().press("Enter"); await expect(page.locator(".reading-panel h1")).toBeVisible();
    await page.getByRole("button", { name: "放大图谱", exact: true }).click(); const expandedUrl = page.url().replace(/([?&])news=[^&]+&?/, "$1").replace(/[?&]$/, "");
    await page.getByRole("button", { name: "关闭阅读面板" }).click(); await expect(page.locator(".reading-panel")).toHaveCount(0); await expect(page).toHaveURL(expandedUrl);
  }
  await page.screenshot({ path: resolve(`outputs/ux-review/graph-${info.project.name}.png`) });
});
