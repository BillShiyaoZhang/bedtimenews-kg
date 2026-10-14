import { test, expect } from "@playwright/test";

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? "").replace(/\/$/, "");
const newsId = "news-2752b2b5e108";
const entityId = "entity-organization-f8be44d48cf6";

test("standalone and graph reading do not automatically fetch heavy navigation routes", async ({ page }) => {
  const heavyRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith(basePath + "/")) return;
    const pathname = url.pathname.slice(basePath.length);
    const headers = request.headers();
    const flight = /\.(?:rsc|txt)$/u.test(pathname) || url.searchParams.has("_rsc") || headers.rsc === "1" || headers.accept?.includes("text/x-component");
    const route = pathname.replace(/\.(?:rsc|txt)$/u, "").replace(/\/index$/u, "").replace(/\/$/u, "");
    const heavy = ["", "/graph", "/ontology"].includes(route) || /^\/(?:graph|ontology)\//u.test(route) || route.startsWith("/__next.");
    if (flight && heavy) heavyRequests.push(url.href);
  });

  await page.goto(`${basePath}/news/${newsId}/`);
  await expect(page.locator(`.standalone-article [data-news-id='${newsId}'] .reading-meta`)).toBeVisible();
  // Include hover intent as well as viewport entry, without intercepting or
  // aborting requests: the built application must become genuinely idle.
  for (const link of await page.locator(".site-header a").all()) if (await link.isVisible()) await link.hover();
  await page.waitForLoadState("networkidle");
  expect(heavyRequests).toEqual([]);

  await page.goto(`${basePath}/graph/?entity=${entityId}`);
  await expect(page.locator(".entity-profile h1")).toHaveText("华为");
  await expect(page.locator(".entity-related-news .news-list-item")).toHaveCount(20);
  for (const link of await page.locator(".site-header a").all()) if (await link.isVisible()) await link.hover();
  await page.waitForLoadState("networkidle");
  expect(heavyRequests).toEqual([]);
  await page.locator(`.entity-related-news h3 a[href$='/news/${newsId}/']`).click();
  await expect(page.locator(`.reading-panel [data-news-id='${newsId}'] .reading-meta`)).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(heavyRequests).toEqual([]);
});
