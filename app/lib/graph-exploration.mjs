/** @typedef {import('./kg').KnowledgeBase} KnowledgeBase */
/** @typedef {import('./kg').Entity} Entity */
/** @typedef {import('./kg').Event} NewsEvent */
/** @typedef {{id:string,label:string,type:string,kind:'entity'|'event',newsId?:string,x:number,y:number}} GraphNode */
/** @typedef {{entityId:string,newsLimit:number,supportLimit:number,eventIds:string[],entityIds:string[]}} Branch */
/** @typedef {{from:string,to:string,kind:'mention'|'relation',label:string}} GraphEdge */
/** @typedef {{x:number,y:number,scale:number}} Viewport */
/** @typedef {{rootId:string,focusId:string,newsId:string,branches:Branch[],nodes:GraphNode[],edges:GraphEdge[],viewport:Viewport,notice:string}} Exploration */
/** @typedef {{focusId:string,page:number}} TimelinePosition */
/** @typedef {{graph:Exploration,timeline:TimelinePosition|null}} GraphUndoSnapshot */
/** @typedef {Record<string, unknown> & {graphExploration?:Exploration,graphUndo?:Array<GraphUndoSnapshot|Exploration>,graphTimeline?:TimelinePosition|null}} GraphHistory */

export const GRAPH_NODE_LIMIT = 120;
export const BRANCH_NEWS_BATCH = 10;
export const BRANCH_ENTITY_BATCH = 6;

/** Build once per accepted graph, rather than scanning all news on each click.
 * @param {KnowledgeBase} kg */
export function createGraphIndex(kg) {
  const entities = new Map(kg.entities.map((row) => [row.id, row]));
  const events = new Map(kg.events.map((row) => [row.id, row]));
  const news = new Map(kg.events.map((row) => [row.newsId, row]));
  /** @type {Map<string, NewsEvent[]>} */
  const byEntity = new Map();
  for (const event of kg.events) {
    for (const entityId of new Set(event.entityIds)) {
      const rows = byEntity.get(entityId) ?? [];
      rows.push(event);
      byEntity.set(entityId, rows);
    }
  }
  for (const rows of byEntity.values()) rows.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return { entities, events, news, byEntity, relations: kg.eventRelations };
}

/** @param {string} rootId @returns {Exploration} */
export function emptyExploration(rootId = '') {
  return { rootId, focusId: rootId, newsId: '', branches: [], nodes: [], edges: [], viewport: { x: 0, y: 0, scale: 1 }, notice: '' };
}

/** @param {Exploration} state */
export function explorationKey(state) {
  return JSON.stringify([state.rootId, state.focusId, state.branches.map((branch) => [branch.entityId, branch.newsLimit, branch.supportLimit])]);
}

/** Retain compatibility with history entries created before timeline snapshots.
 * @param {GraphHistory} current @returns {GraphUndoSnapshot[]} */
export function readGraphUndo(current) {
  /** @type {GraphUndoSnapshot[]} */
  const rows = [];
  for (const row of Array.isArray(current.graphUndo) ? current.graphUndo : []) {
    if (!row || typeof row !== 'object') continue;
    if ('graph' in row && row.graph && Array.isArray(row.graph.nodes)) rows.push(row);
    else if ('rootId' in row && Array.isArray(row.nodes)) rows.push({ graph: row, timeline: null });
  }
  return rows;
}

/** Graph navigation owns its new/replaced entry; a reader ownership marker must
 * never be copied into it. Save reading pagination together with undo state.
 * @param {GraphHistory} current @param {Exploration} previous @param {Exploration} next
 * @param {{replace?:boolean,remember?:boolean,undo?:GraphUndoSnapshot[],timeline?:TimelinePosition|null}} options
 * @returns {GraphHistory} */
export function writeGraphHistory(current, previous, next, options = {}) {
  const undo = readGraphUndo(current);
  const timeline = options.timeline !== undefined ? options.timeline : next.focusId === previous.focusId ? current.graphTimeline ?? null : { focusId: next.focusId, page: 1 };
  const graphUndo = options.undo ?? (options.replace || options.remember === false ? undo : [...undo, { graph: previous, timeline: current.graphTimeline ?? null }].slice(-20));
  const state = { ...current, graphExploration: next, graphUndo, graphTimeline: timeline };
  delete state.atlasReader;
  return state;
}

/** URL pagination takes precedence; retained legacy history is a fallback.
 * @param {string} search @param {string} focusId @param {number} pageCount
 * @param {TimelinePosition|null} saved */
export function readGraphTimelinePage(search, focusId, pageCount, saved = null) {
  const requested = new URLSearchParams(search).get('timelinePage');
  const value = requested === null ? saved?.focusId === focusId ? saved.page : 1 : Number(requested);
  return Math.max(1, Math.min(pageCount, Number.isSafeInteger(value) && value > 0 ? value : 1));
}

/** Keep all existing coordinates; place only new nodes around their branch.
 * @param {GraphNode[]} nodes @param {string} id @param {{x:number,y:number}} anchor */
function nextPosition(nodes, id, anchor) {
  const hash = [...id].reduce((value, letter) => ((value * 31 + letter.codePointAt(0)) >>> 0), 17);
  for (let attempt = 0; attempt < 400; attempt++) {
    const angle = (hash % 628) / 100 + attempt * 2.399963;
    const distance = 145 + Math.sqrt(attempt) * 38;
    const point = { x: anchor.x + Math.cos(angle) * distance, y: anchor.y + Math.sin(angle) * distance };
    if (nodes.every((node) => Math.hypot(node.x - point.x, node.y - point.y) > 76)) return point;
  }
  return { x: anchor.x + nodes.length * 88, y: anchor.y };
}

/** @param {Exploration} state @param {ReturnType<typeof createGraphIndex>} index */
function graphEdges(state, index) {
  const visible = new Set(state.nodes.map((node) => node.id));
  /** @type {GraphEdge[]} */
  const edges = [];
  for (const node of state.nodes) {
    if (node.kind !== 'event') continue;
    for (const entityId of index.events.get(node.id)?.entityIds ?? []) {
      if (visible.has(entityId)) edges.push({ from: entityId, to: node.id, kind: 'mention', label: '报道提及' });
    }
  }
  for (const relation of index.relations) {
    if (visible.has(relation.from) && visible.has(relation.to)) edges.push({ from: relation.from, to: relation.to, kind: 'relation', label: '报道时间先后' });
  }
  return edges;
}

/** @param {Exploration} previous @param {ReturnType<typeof createGraphIndex>} index @param {string} entityId @param {number} newsLimit @param {number} supportLimit */
function materializeBranch(previous, index, entityId, newsLimit, supportLimit) {
  const entity = index.entities.get(entityId);
  if (!entity) return previous;
  const state = { ...previous, nodes: previous.nodes.map((row) => ({ ...row })), branches: previous.branches.map((row) => ({ ...row, entityIds: [...row.entityIds], eventIds: [...row.eventIds] })), focusId: entityId, notice: '' };
  const nodeIds = new Set(state.nodes.map((row) => row.id));
  const focusedNode = state.nodes.find((node) => node.id === previous.focusId);
  let anchor = state.nodes.find((node) => node.id === entityId) ?? focusedNode ?? { x: 450, y: 280 };
  let limited = false;
  /** @param {Entity | NewsEvent} row @param {'entity'|'event'} kind */
  const add = (row, kind) => {
    if (nodeIds.has(row.id)) return true;
    if (state.nodes.length >= GRAPH_NODE_LIMIT) { limited = true; return false; }
    const position = !state.nodes.length ? { x: 450, y: 280 } : nextPosition(state.nodes, row.id, anchor);
    state.nodes.push({ id: row.id, label: kind === 'entity' ? /** @type {Entity} */ (row).label : /** @type {NewsEvent} */ (row).title,
      type: row.type, kind, ...(kind === 'event' ? { newsId: /** @type {NewsEvent} */ (row).newsId } : {}), ...position });
    nodeIds.add(row.id);
    return true;
  };
  if (!add(entity, 'entity')) return { ...previous, notice: '已达到 120 个节点。收起一个分支后可继续展开。' };
  anchor = state.nodes.find((node) => node.id === entityId) ?? anchor;
  const existing = state.branches.find((row) => row.entityId === entityId);
  const branch = existing ?? { entityId, newsLimit, supportLimit, eventIds: [], entityIds: [] };
  branch.newsLimit = newsLimit;
  branch.supportLimit = supportLimit;
  const selectedEvents = (index.byEntity.get(entityId) ?? []).slice(0, newsLimit);
  for (const event of selectedEvents) {
    if (add(event, 'event') && !branch.eventIds.includes(event.id)) branch.eventIds.push(event.id);
  }
  const counts = new Map();
  for (const id of branch.eventIds) for (const supportingId of index.events.get(id)?.entityIds ?? []) {
    if (supportingId !== entityId && index.entities.has(supportingId)) counts.set(supportingId, (counts.get(supportingId) ?? 0) + 1);
  }
  const supporting = [...counts].sort(([a, left], [b, right]) => right - left || a.localeCompare(b)).map(([id]) => id);
  // Previously revealed entities remain part of this branch even if rankings change.
  const chosen = [...new Set([...branch.entityIds, ...supporting])].slice(0, supportLimit);
  for (const id of chosen) {
    const row = index.entities.get(id);
    if (row && add(row, 'entity') && !branch.entityIds.includes(id)) branch.entityIds.push(id);
  }
  if (!existing) state.branches.push(branch);
  state.edges = graphEdges(state, index);
  state.notice = limited ? '已达到 120 个节点。收起一个分支后可继续展开。' : '';
  return state;
}

/** @param {ReturnType<typeof createGraphIndex>} index @param {string} entityId */
export function startExploration(index, entityId) {
  return materializeBranch(emptyExploration(entityId), index, entityId, BRANCH_NEWS_BATCH, BRANCH_ENTITY_BATCH);
}

/** Entity clicks reveal their first branch; repeated clicks focus without paging.
 * @param {Exploration} state @param {ReturnType<typeof createGraphIndex>} index @param {string} entityId */
export function expandEntity(state, index, entityId) {
  if (!state.rootId) return startExploration(index, entityId);
  if (state.branches.some((branch) => branch.entityId === entityId)) return { ...state, focusId: entityId, notice: '' };
  return materializeBranch(state, index, entityId, BRANCH_NEWS_BATCH, BRANCH_ENTITY_BATCH);
}

/** @param {Exploration} state @param {ReturnType<typeof createGraphIndex>} index @param {string} entityId */
export function continueBranch(state, index, entityId) {
  const branch = state.branches.find((row) => row.entityId === entityId);
  if (!branch) return expandEntity(state, index, entityId);
  return materializeBranch(state, index, entityId, branch.newsLimit + BRANCH_NEWS_BATCH, branch.supportLimit + BRANCH_ENTITY_BATCH);
}

/** @param {Exploration} state @param {ReturnType<typeof createGraphIndex>} index @param {string} entityId */
export function collapseBranch(state, index, entityId) {
  const branches = state.branches.filter((row) => row.entityId !== entityId);
  const retained = new Set(state.rootId ? [state.rootId] : []);
  for (const branch of branches) for (const id of [branch.entityId, ...branch.eventIds, ...branch.entityIds]) retained.add(id);
  const next = { ...state, branches, nodes: state.nodes.filter((row) => retained.has(row.id)), notice: '', focusId: retained.has(state.focusId) ? state.focusId : state.rootId };
  next.edges = graphEdges(next, index);
  return next;
}

/** @param {Exploration} state @param {ReturnType<typeof createGraphIndex>} index @param {string} entityId */
export function branchHasMore(state, index, entityId) {
  const branch = state.branches.find((row) => row.entityId === entityId);
  if (!branch) return true;
  const rows = index.byEntity.get(entityId) ?? [];
  const candidates = new Set(rows.slice(0, branch.newsLimit).flatMap((event) => event.entityIds).filter((id) => id !== entityId && index.entities.has(id)));
  return branch.eventIds.length < rows.length || branch.entityIds.length < candidates.size;
}

/** @param {string} search @param {ReturnType<typeof createGraphIndex>} index @param {Exploration | null} saved */
export function readGraphLocation(search, index, saved = null) {
  const params = new URLSearchParams(search);
  const rootId = params.get('entity') ?? '';
  const newsId = index.news.has(params.get('news') ?? '') ? params.get('news') ?? '' : '';
  const requests = [];
  if (rootId && index.entities.has(rootId)) {
    if (!params.has('expanded')) requests.push([rootId, BRANCH_NEWS_BATCH, BRANCH_ENTITY_BATCH]);
    else for (const token of (params.get('expanded') ?? '').split(',')) {
      const [id, news, support] = token.split('~');
      if (!index.entities.has(id) || requests.some(([entityId]) => entityId === id) || requests.length >= GRAPH_NODE_LIMIT) continue;
      requests.push([id, Math.max(0, Math.min(GRAPH_NODE_LIMIT, Number(news) || BRANCH_NEWS_BATCH)), Math.max(0, Math.min(GRAPH_NODE_LIMIT, Number(support) || BRANCH_ENTITY_BATCH))]);
    }
  }
  // A pan or reader history entry should not replay layout for all branches.
  // Validate the saved graph against this immutable dataset and URL first.
  if (saved && Array.isArray(saved.nodes) && Array.isArray(saved.branches) && saved.nodes.length <= GRAPH_NODE_LIMIT && saved.rootId === rootId) {
    const requestedFocus = params.get('focus') ?? rootId;
    const focusId = saved.nodes.some((row) => row.kind === 'entity' && row.id === requestedFocus) ? requestedFocus : rootId;
    const descriptor = JSON.stringify([rootId, focusId, requests]);
    const currentNodes = saved.nodes.every((row) => {
      const current = row.kind === 'entity' ? index.entities.get(row.id) : index.events.get(row.id);
      return current && row.label === ('label' in current ? current.label : current.title) && row.type === current.type && Number.isFinite(row.x) && Number.isFinite(row.y);
    });
    const viewport = saved.viewport;
    if (descriptor === explorationKey(saved) && currentNodes && new Set(saved.nodes.map((node) => node.id)).size === saved.nodes.length
      && viewport && [viewport.x, viewport.y, viewport.scale].every(Number.isFinite) && viewport.scale >= .15 && viewport.scale <= 3) return { ...saved, newsId };
  }
  let state = emptyExploration(rootId);
  if (rootId && index.entities.has(rootId)) {
    if (!params.has('expanded')) state = startExploration(index, rootId);
    else {
      const root = index.entities.get(rootId);
      if (root) state.nodes.push({ id: root.id, kind: 'entity', label: root.label, type: root.type, x: 450, y: 280 });
      for (const token of (params.get('expanded') ?? '').split(',')) {
        const [id, news, support] = token.split('~');
        if (!index.entities.has(id) || state.branches.some((row) => row.entityId === id) || state.branches.length >= GRAPH_NODE_LIMIT) continue;
        const newsLimit = Math.max(0, Math.min(GRAPH_NODE_LIMIT, Number(news) || BRANCH_NEWS_BATCH));
        const supportLimit = Math.max(0, Math.min(GRAPH_NODE_LIMIT, Number(support) || BRANCH_ENTITY_BATCH));
        state = materializeBranch(state, index, id, newsLimit, supportLimit);
      }
    }
    const focusId = params.get('focus') ?? rootId;
    state.focusId = state.nodes.some((row) => row.kind === 'entity' && row.id === focusId) ? focusId : rootId;
  }
  state.newsId = newsId;
  state.viewport = fitGraphViewport(state.nodes);
  return state;
}

/** @param {Exploration} state @param {string} search @param {number|undefined} timelinePage */
export function graphLocationSearch(state, search = '', timelinePage = undefined) {
  const params = new URLSearchParams(search);
  const previousFocus = params.get('focus') ?? params.get('entity') ?? '';
  const requestedPage = timelinePage ?? (previousFocus === state.focusId ? Number(params.get('timelinePage')) : 1);
  for (const name of ['entity', 'focus', 'expanded', 'timelinePage']) params.delete(name);
  if (state.rootId) {
    params.set('entity', state.rootId);
    params.set('focus', state.focusId);
    params.set('expanded', state.branches.map((row) => `${row.entityId}~${row.newsLimit}~${row.supportLimit}`).join(','));
    if (Number.isSafeInteger(requestedPage) && requestedPage > 1) params.set('timelinePage', String(requestedPage));
  }
  const value = params.toString();
  return value ? `?${value}` : '';
}

/** @param {GraphNode[]} nodes @returns {Viewport} */
export function fitGraphViewport(nodes) {
  if (!nodes.length) return { x: 0, y: 0, scale: 1 };
  const minX = Math.min(...nodes.map((node) => node.x)) - 90;
  const maxX = Math.max(...nodes.map((node) => node.x)) + 90;
  const minY = Math.min(...nodes.map((node) => node.y)) - 60;
  const maxY = Math.max(...nodes.map((node) => node.y)) + 90;
  const scale = Math.max(.15, Math.min(1.5, 900 / (maxX - minX), 560 / (maxY - minY)));
  return { x: 450 - (minX + maxX) / 2 * scale, y: 280 - (minY + maxY) / 2 * scale, scale };
}

/** @param {Viewport} viewport @param {number} factor @param {{x:number,y:number}} center */
export function zoomGraphViewport(viewport, factor, center = { x: 450, y: 280 }) {
  const scale = Math.max(.15, Math.min(3, viewport.scale * factor));
  const ratio = scale / viewport.scale;
  return { x: center.x - (center.x - viewport.x) * ratio, y: center.y - (center.y - viewport.y) * ratio, scale };
}
