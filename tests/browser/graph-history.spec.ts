import { test, expect, type Page, type Locator } from "@playwright/test";

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? "").replace(/\/$/, "");
const ROOT = "entity-organization-f8be44d48cf6"; // 华为
const DIGITAL = "entity-topic-8a581a8f5d03"; // 数字经济
const GOVERNANCE = "entity-topic-ba1dbbad6e64"; // 公共治理
const NEWS = "news-2752b2b5e108";

type Branch = { entityId: string; eventIds: string[]; entityIds: string[] };
type GraphSnapshot = {
  rootId: string; focusId: string; branches: Branch[];
  viewport: { x: number; y: number; scale: number };
  nodes: { id: string; x: number; y: number }[];
  timeline: { focusId: string; page: number } | null;
  ownsReader: boolean;
};

const graphNode = (page: Page, id: string) => page.getByTestId("knowledge-graph-canvas").locator(`[data-node="${id}"]`);
const pager = (page: Page) => page.getByRole("navigation", { name: "相关新闻分页", exact: true });
const timeline = (page: Page) => page.locator(".entity-related-news .news-list-item");

async function openGraph(page: Page) {
  await page.goto(`${basePath}/graph/?entity=${ROOT}`);
  await expect(page.locator(".entity-profile h1")).toHaveText("华为");
  await expect(timeline(page)).toHaveCount(20);
  if (page.viewportSize()!.width <= 900) await page.getByRole("button", { name: "展开关系图谱", exact: true }).click();
  await expect(page.getByTestId("knowledge-graph-canvas")).toBeVisible();
}

async function snapshot(page: Page): Promise<GraphSnapshot> {
  await expect.poll(() => page.evaluate(() => !!window.history.state?.graphExploration)).toBe(true);
  return page.evaluate(() => {
    const graph = window.history.state.graphExploration;
    return { rootId: graph.rootId, focusId: graph.focusId, branches: graph.branches,
      viewport: graph.viewport, nodes: graph.nodes, timeline: window.history.state.graphTimeline ?? null,
      ownsReader: !!window.history.state.atlasReader };
  });
}

async function expand(page: Page, id: string, name: string) {
  await expect(graphNode(page, id)).toHaveCount(1);
  await graphNode(page, id).press("Enter");
  await expect(page.locator(".entity-profile h1")).toHaveText(name);
  await expect.poll(() => new URL(page.url()).searchParams.get("focus")).toBe(id);
}

async function positions(graph: Locator) {
  return graph.locator("[data-node]").evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [node.getAttribute("data-node")!, node.getAttribute("transform")!])));
}

async function expectTouchTargets(graph: Locator) {
  const nodes = await graph.locator("[data-node]").count();
  expect(nodes).toBeGreaterThan(0);
  await expect(graph.locator("[data-hit-target]")).toHaveCount(nodes);
  await expect.poll(() => graph.locator("[data-hit-target]").evaluateAll((targets) => targets.map((target) => {
    const box = target.getBoundingClientRect();
    return { id: target.parentElement!.getAttribute("data-node"), width: box.width, height: box.height };
  }).filter((target) => target.width < 44 || target.height < 44))).toEqual([]);
}

test("screen-sized node targets support touch, repeated expansion and nearest selection in a dense graph", async ({ page }, info) => {
  const touch = info.project.use.hasTouch === true;
  const pressPoint = async (point: { x: number; y: number }) => {
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
  };
  await openGraph(page);
  const graph = page.getByTestId("knowledge-graph-canvas");
  const fit = page.getByRole("button", { name: "适应视图", exact: true });
  const pressNode = async (id: string) => {
    await graph.scrollIntoViewIfNeeded();
    const box = await graphNode(page, id).locator("[data-node-symbol]").boundingBox();
    expect(box).not.toBeNull();
    await pressPoint({ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  };
  await fit.click();
  await expectTouchTargets(graph);
  const originalSize = page.viewportSize()!;
  const originalPositions = await positions(graph);
  const originalViewport = (await snapshot(page)).viewport;
  await page.setViewportSize({ ...originalSize, width: originalSize.width > 900 ? originalSize.width - 80 : originalSize.width + 80 });
  await expectTouchTargets(graph);
  expect(await positions(graph)).toEqual(originalPositions);
  expect((await snapshot(page)).viewport).toEqual(originalViewport);
  await page.setViewportSize(originalSize);
  await expectTouchTargets(graph);
  await graph.scrollIntoViewIfNeeded();

  // On phones this is outside the tiny visible circle, but inside its actual
  // transparent target. Pick a point closest to this node's visible center;
  // painted SVG order alone is intentionally irrelevant when targets overlap.
  if (touch) {
    const edgePoint = await graphNode(page, DIGITAL).evaluate((node) => {
      const circle = node.querySelector("[data-node-symbol]")!.getBoundingClientRect();
      const cx = circle.x + circle.width / 2, cy = circle.y + circle.height / 2;
      const svg = node.closest("svg")!;
      const centers = [...svg.querySelectorAll("[data-node]")].map((other) => {
        const box = other.querySelector("[data-node-symbol]")!.getBoundingClientRect();
        return { node: other, x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      return [[20, 0], [-20, 0], [0, 20], [0, -20], [14, 14], [-14, 14], [14, -14], [-14, -14], [12, 0], [-12, 0], [0, 12], [0, -12]].map(([dx, dy]) => ({ x: cx + dx, y: cy + dy })).find((point) =>
        !(point.x >= circle.left && point.x <= circle.right && point.y >= circle.top && point.y <= circle.bottom)
        && document.elementFromPoint(point.x, point.y)?.closest("svg") === svg
        && centers.every((other) => other.node === node || Math.hypot(point.x - cx, point.y - cy) < Math.hypot(point.x - other.x, point.y - other.y)));
    });
    expect(edgePoint).toBeDefined();
    await pressPoint(edgePoint!);
  } else await pressNode(DIGITAL);
  await expect(page.locator(".entity-profile h1")).toHaveText("数字经济");
  const expanded = await snapshot(page);
  const historyLength = await page.evaluate(() => history.length);
  await pressNode(DIGITAL);
  expect((await snapshot(page)).branches).toEqual(expanded.branches);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect((await snapshot(page)).rootId).toBe(ROOT);
  await fit.click(); await pressNode(GOVERNANCE);
  await expect(page.locator(".entity-profile h1")).toHaveText("公共治理");
  await fit.click(); await pressNode(DIGITAL);
  await expect(page.locator(".entity-profile h1")).toHaveText("数字经济");
  await page.getByRole("button", { name: "收起当前分支", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).branches.map((branch) => branch.entityId)).toEqual([ROOT, GOVERNANCE]);
  await expectTouchTargets(graph);
  await fit.click();
  const newsNode = graph.locator(`[data-news-id='${NEWS}']`);
  const newsNodeId = await newsNode.getAttribute("data-node");
  await pressNode(newsNodeId!);
  await expect(page.locator(".reading-panel h1")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("news")).toBe(NEWS);
  await page.getByRole("button", { name: "关闭阅读面板", exact: true }).click();
  await expect(page.locator(".reading-panel")).toHaveCount(0);

  await page.getByRole("button", { name: "重置到起点", exact: true }).click();
  for (let i = 0; i < 6; i++) await page.getByRole("button", { name: "缩小图谱", exact: true }).click();
  await graph.scrollIntoViewIfNeeded();
  await expectTouchTargets(graph);
  // Find a real painted overlap: SVG order would send this center click to a
  // different node. The chosen node is unambiguously closest to its own center.
  const overlapped = await graph.evaluate((svg) => {
    const bounds = svg.getBoundingClientRect();
    return [...svg.querySelectorAll("[data-node]")].map((node) => {
      const box = node.querySelector("[data-node-symbol]")!.getBoundingClientRect();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const painted = document.elementFromPoint(x, y)?.closest("[data-node]");
      return { id: node.getAttribute("data-node")!, kind: node.getAttribute("data-kind"), newsId: node.getAttribute("data-news-id"),
        label: node.querySelector("title")!.textContent!, x, y, visible: x > bounds.left + 24 && x < bounds.right - 24 && y > bounds.top + 24 && y < bounds.bottom - 24,
        intercepted: painted !== node && !!painted };
    }).find((node) => node.visible && node.intercepted && node.id !== "entity-organization-f8be44d48cf6");
  });
  expect(overlapped).toBeDefined();
  await pressPoint(overlapped!);
  if (overlapped!.kind === "entity") {
    await expect(page.locator(".entity-profile h1")).toHaveText(overlapped!.label);
    expect(new URL(page.url()).searchParams.get("focus")).toBe(overlapped!.id);
  } else {
    await expect(page.locator(".reading-panel h1")).toHaveText(overlapped!.label);
    expect(new URL(page.url()).searchParams.get("news")).toBe(overlapped!.newsId);
    await page.getByRole("button", { name: "关闭阅读面板", exact: true }).click();
    await expect(page.locator(".reading-panel")).toHaveCount(0);
  }
  // Keyboard selection remains the explicitly focused node even at this density.
  await expand(page, DIGITAL, "数字经济");
  await expectTouchTargets(graph);
});

test("expanding real shared branches preserves coordinates and collapse retains independent context", async ({ page }) => {
  await openGraph(page);
  const graph = page.getByTestId("knowledge-graph-canvas");
  const initial = await positions(graph);
  await expand(page, DIGITAL, "数字经济");
  const second = await positions(graph);
  for (const [id, position] of Object.entries(initial)) await expect(graphNode(page, id)).toHaveAttribute("transform", position);
  await expand(page, GOVERNANCE, "公共治理");
  for (const [id, position] of Object.entries(second)) await expect(graphNode(page, id)).toHaveAttribute("transform", position);
  const before = await snapshot(page);
  expect(before.rootId).toBe(ROOT);
  expect(before.nodes.length).toBeLessThanOrEqual(120);

  // Focus B without starting it again, then remove only B's owned branch.
  await expand(page, DIGITAL, "数字经济");
  await page.getByRole("button", { name: "收起当前分支", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).branches.map((branch) => branch.entityId)).toEqual([ROOT, GOVERNANCE]);
  const after = await snapshot(page);
  expect(after.branches.map((branch) => branch.entityId)).toEqual([ROOT, GOVERNANCE]);
  const retained = new Set([ROOT]);
  for (const branch of after.branches) for (const id of [branch.entityId, ...branch.eventIds, ...branch.entityIds]) retained.add(id);
  expect(after.nodes.map((node) => node.id).sort()).toEqual([...retained].sort());
  await expect(graphNode(page, GOVERNANCE)).toHaveCount(1);
  await expect(graphNode(page, ROOT)).toHaveAttribute("transform", initial[ROOT]);

  // The root remains visible even after its own branch is collapsed.
  await expand(page, ROOT, "华为");
  await page.getByRole("button", { name: "收起当前分支", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).branches.map((branch) => branch.entityId)).toEqual([GOVERNANCE]);
  await expect(graphNode(page, ROOT)).toHaveCount(1);
  await expect(graphNode(page, GOVERNANCE)).toHaveCount(1);
  expect((await snapshot(page)).branches.map((branch) => branch.entityId)).toEqual([GOVERNANCE]);
  await page.reload();
  await expect(page.locator(".entity-profile h1")).toHaveText("华为");
  if (page.viewportSize()!.width <= 900) await page.getByRole("button", { name: "展开关系图谱", exact: true }).click();
  await expect(graphNode(page, ROOT)).toHaveCount(1);
  await expect(graphNode(page, GOVERNANCE)).toHaveCount(1);
});

test("twenty-item timeline pages survive undo and browser back/forward with the correct entity", async ({ page }) => {
  await openGraph(page);
  await pager(page).getByRole("button", { name: "下一页", exact: true }).click();
  await expect(pager(page)).toContainText("第 2 /");
  await expect.poll(() => new URL(page.url()).searchParams.get("timelinePage")).toBe("2");
  const aTitle = await timeline(page).first().locator("h3").textContent();
  await expand(page, DIGITAL, "数字经济");
  await expect(pager(page)).toContainText("第 1 /");
  expect(new URL(page.url()).searchParams.has("timelinePage")).toBe(false);
  await pager(page).getByRole("button", { name: "下一页", exact: true }).click();
  const bTitle = await timeline(page).first().locator("h3").textContent();
  await expect(timeline(page)).toHaveCount(20);
  await expand(page, GOVERNANCE, "公共治理");
  await expect(pager(page)).toContainText("第 1 /");
  await page.getByRole("button", { name: "撤销上一步", exact: true }).click();
  await expect(page.locator(".entity-profile h1")).toHaveText("数字经济");
  await expect(pager(page)).toContainText("第 2 /");
  await expect(timeline(page).first().locator("h3")).toHaveText(bTitle!);
  await expect.poll(() => new URL(page.url()).searchParams.get("timelinePage")).toBe("2");

  // Undo creates an explicit new entry. Back traverses the original actions.
  await page.goBack(); await expect(page.locator(".entity-profile h1")).toHaveText("公共治理");
  await page.goBack(); await expect(page.locator(".entity-profile h1")).toHaveText("数字经济");
  await expect(pager(page)).toContainText("第 2 /");
  await expect(timeline(page).first().locator("h3")).toHaveText(bTitle!);
  await page.goBack(); await expect(page.locator(".entity-profile h1")).toHaveText("华为");
  await expect(pager(page)).toContainText("第 2 /");
  await expect(timeline(page).first().locator("h3")).toHaveText(aTitle!);
  await page.goForward(); await expect(page.locator(".entity-profile h1")).toHaveText("数字经济");
  await expect(pager(page)).toContainText("第 2 /");
  await page.reload(); await expect(page.locator(".entity-profile h1")).toHaveText("数字经济");
  await expect(pager(page)).toContainText("第 2 /");
  // A fresh navigation with no history payload restores a shared page URL too.
  await page.goto(`${basePath}/graph/?entity=${ROOT}&timelinePage=2`);
  await expect(pager(page)).toContainText("第 2 /");
  await expect(timeline(page).first().locator("h3")).toHaveText(aTitle!);
});

test("closing a reader after graph focus, viewport and page mutations preserves current exploration", async ({ page }) => {
  test.skip(page.viewportSize()!.width < 1100, "Background exploration is intentionally inert while the phone/tablet reader is open.");
  await openGraph(page);
  const graph = page.getByTestId("knowledge-graph-canvas");
  await page.locator(`.entity-related-news h3 a[href$='/news/${NEWS}/']`).click();
  await expect(page.locator(".reading-panel h1")).toBeVisible();
  await expand(page, DIGITAL, "数字经济");
  const focused = await snapshot(page);
  expect(focused.ownsReader).toBe(false);
  await page.getByRole("button", { name: "关闭阅读面板", exact: true }).click();
  await expect(page.locator(".reading-panel")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("news")).toBe(false);
  expect((await snapshot(page)).nodes).toEqual(focused.nodes);
  await expect(page.locator(".entity-profile h1")).toHaveText("数字经济");

  await graph.locator('[data-kind="event"]').first().press("Enter");
  await expect(page.locator(".reading-panel h1")).toBeVisible();
  const beforePan = (await snapshot(page)).viewport;
  await graph.press("ArrowRight");
  const panned = await snapshot(page);
  expect(panned.viewport.x).not.toBe(beforePan.x);
  expect(panned.ownsReader).toBe(false);
  await pager(page).getByRole("button", { name: "下一页", exact: true }).click();
  await expect(pager(page)).toContainText("第 2 /");
  await page.getByRole("button", { name: "关闭阅读面板", exact: true }).click();
  await expect(page.locator(".reading-panel")).toHaveCount(0);
  expect((await snapshot(page)).viewport).toEqual(panned.viewport);
  await expect(pager(page)).toContainText("第 2 /");
});

test("SVG nodes activate from the keyboard and its viewport supports pan zoom fit and browser restoration", async ({ page }) => {
  await openGraph(page);
  const graph = page.getByTestId("knowledge-graph-canvas");
  await graph.focus();
  await graph.press("ArrowRight");
  const panned = await snapshot(page);
  await graph.press("+");
  expect((await snapshot(page)).viewport.scale).toBeGreaterThan(panned.viewport.scale);
  await graph.press("Home");
  const fitted = await snapshot(page);
  expect(fitted.viewport.scale).toBeGreaterThan(0);
  await graph.focus();
  await page.keyboard.press("Tab");
  await expect(graphNode(page, ROOT)).toBeFocused();
  await expand(page, DIGITAL, "数字经济");
  await expect(graphNode(page, GOVERNANCE)).toHaveCount(1);
  await graphNode(page, GOVERNANCE).press("Space");
  await expect(page.locator(".entity-profile h1")).toHaveText("公共治理");
  await page.goBack(); await expect(page.locator(".entity-profile h1")).toHaveText("数字经济");
  expect((await snapshot(page)).viewport).toEqual(fitted.viewport);
  await page.goBack(); await expect(page.locator(".entity-profile h1")).toHaveText("华为");
  expect((await snapshot(page)).viewport).toEqual(fitted.viewport);
});

test("phone and tablet start with news, expose the graph explicitly and return to it after modal reading", async ({ page }) => {
  test.skip(page.viewportSize()!.width > 900, "Desktop has a persistent graph workspace.");
  await page.goto(`${basePath}/graph/?entity=${ROOT}`);
  await expect(timeline(page)).toHaveCount(20);
  const graph = page.getByTestId("knowledge-graph-canvas");
  await expect(graph).not.toBeVisible();
  const toggle = page.getByRole("button", { name: "展开关系图谱", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect((await toggle.boundingBox())!.y).toBeLessThan(page.viewportSize()!.height);
  await toggle.click(); await expect(graph).toBeVisible();
  await expect(page.getByRole("button", { name: "收起关系图谱", exact: true })).toHaveAttribute("aria-expanded", "true");
  await graph.locator('[data-kind="event"]').first().press("Enter");
  await expect(page.getByRole("dialog", { name: "新闻阅读", exact: true })).toBeVisible();
  await expect(page.locator('div[inert]')).toHaveCount(1);
  await expect(page.locator(".reading-panel h1")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".reading-panel")).toHaveCount(0);
  await expect(page.locator('div[inert]')).toHaveCount(0);
  await expect(graph).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("direct unknown entity and reader links keep the requested graph context and close in place", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${basePath}/graph/?entity=entity-does-not-exist`);
  await expect(page.locator(".entity-profile h1")).toHaveText("未找到这个实体");
  await expect(page.locator(".graph-node")).toHaveCount(0);
  await page.goto(`${basePath}/graph/?entity=${ROOT}&news=news-does-not-exist`);
  await expect(page.locator(".reading-panel")).toContainText("未找到这条记录");
  await page.getByRole("button", { name: "关闭阅读面板", exact: true }).click();
  await expect(page.locator(".reading-panel")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("entity")).toBe(ROOT);
  await expect(page.locator(".entity-profile h1")).toHaveText("华为");
  expect(errors).toEqual([]);
});
