import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGraphIndex, startExploration, expandEntity, continueBranch,
  collapseBranch, branchHasMore, readGraphLocation, graphLocationSearch,
  fitGraphViewport, zoomGraphViewport, GRAPH_NODE_LIMIT,
  readGraphUndo, writeGraphHistory, readGraphTimelinePage,
} from '../app/lib/graph-exploration.mjs';

function fixture(branches = 12, newsPerBranch = 28) {
  const entities = Array.from({ length: branches * 8 }, (_, i) => ({ id: `entity-${i}`, label: `实体 ${i}`, type: 'person', aliases: [], description: '' }));
  const events = [];
  for (let branch = 0; branch < branches; branch++) for (let n = 0; n < newsPerBranch; n++) {
    events.push({ id: `event-${branch}-${n}`, newsId: `news-${branch}-${n}`, title: `新闻 ${branch}-${n}`, type: 'policy', date: `2026-01-${String(28 - n).padStart(2, '0')}`, entityIds: [entities[branch * 8].id, ...entities.slice(branch * 8 + 1, branch * 8 + 8).map((row) => row.id)] });
  }
  return createGraphIndex({ entities, events, eventRelations: [], entityRelations: [], sources: [] });
}

test('empty and historical URLs never silently pick an unrelated entity', () => {
  const index = fixture();
  assert.equal(readGraphLocation('', index).rootId, '');
  assert.deepEqual(readGraphLocation('', index).nodes, []);
  assert.equal(readGraphLocation('?entity=missing', index).rootId, 'missing');
  assert.deepEqual(readGraphLocation('?entity=missing', index).nodes, []);
  const legacy = readGraphLocation('?entity=entity-0', index);
  assert.equal(legacy.rootId, 'entity-0');
  assert.equal(legacy.focusId, 'entity-0');
  assert.equal(legacy.branches[0].eventIds.length, 10);
  assert.equal(legacy.branches[0].entityIds.length, 6);
});

test('expansion preserves the original root, nodes, coordinates, and source state', () => {
  const index = fixture();
  const initial = startExploration(index, 'entity-0');
  const serialized = JSON.stringify(initial);
  const next = expandEntity(initial, index, 'entity-8');
  assert.equal(next.rootId, 'entity-0');
  assert.equal(next.focusId, 'entity-8');
  assert.equal(next.branches.length, 2);
  for (const node of initial.nodes) {
    const kept = next.nodes.find((row) => row.id === node.id);
    assert.equal(kept.x, node.x);
    assert.equal(kept.y, node.y);
  }
  assert.equal(JSON.stringify(initial), serialized);
  const focusedAgain = expandEntity(next, index, 'entity-8');
  assert.equal(focusedAgain.nodes.length, next.nodes.length);
  assert.equal(focusedAgain.branches.length, 2);
});

test('continuing reveals the next batch and never duplicates shared nodes or edges', () => {
  const index = fixture();
  const initial = startExploration(index, 'entity-0');
  const continued = continueBranch(initial, index, 'entity-0');
  assert.equal(continued.branches[0].eventIds.length, 20);
  assert.equal(continued.branches[0].entityIds.length, 7);
  assert.equal(new Set(continued.nodes.map((node) => node.id)).size, continued.nodes.length);
  assert.equal(new Set(continued.edges.map((edge) => `${edge.kind}:${edge.from}:${edge.to}`)).size, continued.edges.length);
  assert.equal(branchHasMore(continued, index, 'entity-0'), true);
  const finished = continueBranch(continued, index, 'entity-0');
  assert.equal(finished.branches[0].eventIds.length, 28);
  assert.equal(branchHasMore(finished, index, 'entity-0'), false);
});

test('the 120-node limit is enforced without evicting previously shown nodes', () => {
  const index = fixture(30);
  let state = startExploration(index, 'entity-0');
  const original = state.nodes.map((node) => node.id);
  for (let branch = 1; branch < 30; branch++) state = expandEntity(state, index, `entity-${branch * 8}`);
  assert.equal(state.nodes.length, GRAPH_NODE_LIMIT);
  assert.match(state.notice, /120/);
  assert.ok(original.every((id) => state.nodes.some((node) => node.id === id)));
});

test('collapsing removes only an owned branch and preserves independently expanded context', () => {
  const index = fixture();
  const root = startExploration(index, 'entity-0');
  const two = expandEntity(root, index, 'entity-8');
  const collapsed = collapseBranch(two, index, 'entity-0');
  assert.ok(collapsed.nodes.some((node) => node.id === 'entity-0'));
  assert.ok(collapsed.nodes.some((node) => node.id === 'event-1-0'));
  assert.ok(!collapsed.nodes.some((node) => node.id === 'event-0-0'));
  assert.equal(collapsed.branches.length, 1);
  assert.equal(collapsed.focusId, 'entity-8');
  const freed = collapseBranch(two, index, 'entity-8');
  assert.equal(freed.focusId, 'entity-0');
  assert.deepEqual(freed.nodes, root.nodes);
});

test('URL round trips branches and paging, while history restores exact coordinates and viewport', () => {
  const index = fixture();
  let state = continueBranch(expandEntity(startExploration(index, 'entity-0'), index, 'entity-8'), index, 'entity-8');
  state = { ...state, viewport: { x: 180, y: -70, scale: .7 }, nodes: state.nodes.map((row) => ({ ...row, x: row.x + 11 })) };
  const search = graphLocationSearch(state, '?type=person&news=news-1-0');
  const parsed = readGraphLocation(search, index);
  assert.equal(parsed.rootId, state.rootId);
  assert.equal(parsed.focusId, state.focusId);
  assert.deepEqual(parsed.branches.map((row) => [row.entityId, row.newsLimit, row.supportLimit]), state.branches.map((row) => [row.entityId, row.newsLimit, row.supportLimit]));
  assert.equal(parsed.newsId, 'news-1-0');
  assert.equal(new URLSearchParams(search).get('type'), 'person');
  const restored = readGraphLocation(search, index, state);
  assert.deepEqual(restored.nodes, state.nodes);
  assert.deepEqual(restored.viewport, state.viewport);
});

test('invalid expanded IDs and stale history cannot broaden or override the requested graph', () => {
  const index = fixture();
  const old = startExploration(index, 'entity-0');
  const next = readGraphLocation('?entity=entity-8&expanded=missing~100000~100000,entity-8~10~6&focus=missing', index, old);
  assert.equal(next.rootId, 'entity-8');
  assert.equal(next.focusId, 'entity-8');
  assert.equal(next.branches.length, 1);
  assert.ok(next.nodes.every((row) => !row.id.startsWith('event-0-')));
});

test('reloading a collapsed-root URL reserves the root without overlapping its retained branches', () => {
  const index = fixture();
  const state = collapseBranch(expandEntity(startExploration(index, 'entity-0'), index, 'entity-8'), index, 'entity-0');
  const restored = readGraphLocation(graphLocationSearch(state), index);
  const root = restored.nodes.find((row) => row.id === 'entity-0');
  const branch = restored.nodes.find((row) => row.id === 'entity-8');
  assert.ok(root && branch);
  assert.notDeepEqual([root.x, root.y], [branch.x, branch.y]);
  assert.equal(restored.branches.length, 1);
  assert.equal(restored.branches[0].entityId, 'entity-8');
});

test('fit contains nodes and zoom keeps its chosen center fixed', () => {
  const index = fixture();
  const state = expandEntity(startExploration(index, 'entity-0'), index, 'entity-8');
  const fit = fitGraphViewport(state.nodes);
  for (const row of state.nodes) {
    assert.ok(row.x * fit.scale + fit.x >= 0 && row.x * fit.scale + fit.x <= 900);
    assert.ok(row.y * fit.scale + fit.y >= 0 && row.y * fit.scale + fit.y <= 560);
  }
  const center = { x: 200, y: 150 };
  const zoom = zoomGraphViewport(fit, 1.2, center);
  assert.ok(Math.abs((center.x - fit.x) / fit.scale - (center.x - zoom.x) / zoom.scale) < 1e-9);
  assert.ok(Math.abs((center.y - fit.y) / fit.scale - (center.y - zoom.y) / zoom.scale) < 1e-9);
});

test('graph push and viewport/page replace clear reader ownership while retaining unrelated router state', () => {
  const index = fixture();
  const a = startExploration(index, 'entity-0');
  const b = expandEntity(a, index, 'entity-8');
  const readerEntry = { atlasReader: { url: '/graph?entity=entity-0&news=news-0-0', parentUrl: '/graph?entity=entity-0' }, graphExploration: a, graphTimeline: { focusId: a.focusId, page: 2 }, router: { preserved: true } };
  const pushed = writeGraphHistory(readerEntry, a, b);
  assert.equal('atlasReader' in pushed, false);
  assert.deepEqual(pushed.router, { preserved: true });
  assert.deepEqual(readerEntry.atlasReader, { url: '/graph?entity=entity-0&news=news-0-0', parentUrl: '/graph?entity=entity-0' });
  const panned = writeGraphHistory(readerEntry, a, { ...a, viewport: { x: 100, y: 0, scale: .8 } }, { replace: true });
  assert.equal('atlasReader' in panned, false);
  assert.equal(readGraphUndo(panned).length, 0);
  const paged = writeGraphHistory(readerEntry, a, a, { replace: true, timeline: { focusId: a.focusId, page: 3 } });
  assert.equal('atlasReader' in paged, false);
  assert.equal(paged.graphTimeline.page, 3);
});

test('undo restores the previous entity timeline page as well as its graph and viewport', () => {
  const index = fixture();
  const a = startExploration(index, 'entity-0');
  const b = expandEntity(a, index, 'entity-8');
  const c = expandEntity(b, index, 'entity-16');
  const onB = { graphExploration: b, graphTimeline: { focusId: b.focusId, page: 2 } };
  const onC = writeGraphHistory(onB, b, c);
  const stack = readGraphUndo(onC);
  const previous = stack.at(-1);
  const undone = writeGraphHistory(onC, c, previous.graph, { undo: stack.slice(0, -1), remember: false, timeline: previous.timeline });
  assert.equal(undone.graphExploration.focusId, b.focusId);
  assert.deepEqual(undone.graphExploration.nodes, b.nodes);
  assert.deepEqual(undone.graphExploration.viewport, b.viewport);
  assert.deepEqual(undone.graphTimeline, { focusId: b.focusId, page: 2 });
});

test('archived graph entries round trip across reader opening and an independent graph mutation', () => {
  const index = fixture();
  const a = startExploration(index, 'entity-0');
  const aUrl = graphLocationSearch(a);
  const original = { graphExploration: a, graphTimeline: { focusId: a.focusId, page: 2 } };
  const newsUrl = `${aUrl}&news=news-0-0`;
  const reader = { ...original, atlasReader: { url: newsUrl, parentUrl: aUrl } };
  const graphWithNews = readGraphLocation(newsUrl, index, reader.graphExploration);
  const b = expandEntity(graphWithNews, index, 'entity-8');
  const bState = writeGraphHistory(reader, graphWithNews, b);
  const bUrl = graphLocationSearch(b, newsUrl);
  assert.equal('atlasReader' in bState, false);
  const closedUrl = new URL(`https://example.test/graph/${bUrl}`);
  closedUrl.searchParams.delete('news');
  const closed = readGraphLocation(closedUrl.search, index, bState.graphExploration);
  assert.equal(closed.focusId, 'entity-8');
  assert.equal(closed.newsId, '');
  assert.deepEqual(closed.nodes, b.nodes);
  // Back to the exact previous entry restores the older entity's page 2.
  const back = readGraphLocation(aUrl, index, original.graphExploration);
  assert.equal(back.focusId, 'entity-0');
  assert.deepEqual(back.nodes, a.nodes);
  assert.equal(original.graphTimeline.page, 2);
});

test('legacy exploration-only undo entries remain usable', () => {
  const graph = startExploration(fixture(), 'entity-0');
  assert.deepEqual(readGraphUndo({ graphUndo: [graph] }), [{ graph, timeline: null }]);
});

test('timeline URL pages take precedence over history while legacy entries retain their page', () => {
  const saved = { focusId: 'entity-0', page: 3 };
  assert.equal(readGraphTimelinePage('?timelinePage=2', 'entity-0', 5, saved), 2);
  assert.equal(readGraphTimelinePage('', 'entity-0', 5, saved), 3);
  assert.equal(readGraphTimelinePage('', 'entity-8', 5, saved), 1);
  assert.equal(readGraphTimelinePage('?timelinePage=999', 'entity-0', 5, saved), 5);
  for (const value of ['0', '-1', '1.5', 'invalid']) assert.equal(readGraphTimelinePage(`?timelinePage=${value}`, 'entity-0', 5, saved), 1);
});

test('graph URL paging stays independent of homepage page and resets on a focus change', () => {
  const index = fixture();
  const a = startExploration(index, 'entity-0');
  const search = graphLocationSearch(a, '?page=4&news=news-0-0', 3);
  let params = new URLSearchParams(search);
  assert.equal(params.get('page'), '4');
  assert.equal(params.get('timelinePage'), '3');
  assert.equal(params.get('news'), 'news-0-0');
  const b = expandEntity(a, index, 'entity-8');
  params = new URLSearchParams(graphLocationSearch(b, search));
  assert.equal(params.has('timelinePage'), false);
  assert.equal(params.get('page'), '4');
  assert.equal(new URLSearchParams(graphLocationSearch(b, search, 2)).get('timelinePage'), '2');
});
