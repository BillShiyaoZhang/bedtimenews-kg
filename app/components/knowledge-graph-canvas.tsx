"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { Ontology } from "../lib/kg";
import { fitGraphViewport, zoomGraphViewport, type Exploration, type Viewport } from "../lib/graph-exploration.mjs";

type KnowledgeGraphCanvasProps = {
  graph: Exploration;
  ontology: Ontology;
  onSelectEntity: (id: string) => void;
  onSelectNews: (id: string) => void;
  onViewportChange: (viewport: Viewport) => void;
};
const NODE_TARGET_PX = 48;

export function KnowledgeGraphCanvas({ graph, ontology, onSelectEntity, onSelectNews, onViewportChange }: KnowledgeGraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; clientX: number; clientY: number; moved: boolean; viewport: Viewport } | null>(null);
  const suppressClick = useRef(false);
  const [screenScale, setScreenScale] = useState({ x: 1, y: 1 });
  const [hovered, setHovered] = useState("");
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const typeColors = useMemo(() => new Map([...ontology.entityTypes, ...ontology.eventTypes].map((type) => [type.id, type.color])), [ontology]);
  const point = (event: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (svg && matrix) {
      const coordinate = svg.createSVGPoint();
      coordinate.x = event.clientX;
      coordinate.y = event.clientY;
      return coordinate.matrixTransform(matrix.inverse());
    }
    return { x: event.clientX, y: event.clientY };
  };
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const matrix = svg.getScreenCTM();
      if (!matrix || !svg.getBoundingClientRect().width) return;
      const x = Math.hypot(matrix.a, matrix.b);
      const y = Math.hypot(matrix.c, matrix.d);
      if (x && y) setScreenScale((previous) => Math.abs(previous.x - x) < 1e-6 && Math.abs(previous.y - y) < 1e-6 ? previous : { x, y });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const hitWidth = NODE_TARGET_PX / (screenScale.x * graph.viewport.scale);
  const hitHeight = NODE_TARGET_PX / (screenScale.y * graph.viewport.scale);
  const selectNode = (node: Exploration["nodes"][number]) => {
    if (node.kind === "entity") onSelectEntity(node.id);
    else if (node.newsId) onSelectNews(node.newsId);
  };
  const nearestNode = (event: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return undefined;
    const rectangle = svg.getBoundingClientRect();
    const bounds = { left: Math.max(0, rectangle.left), top: Math.max(0, rectangle.top), right: Math.min(window.innerWidth, rectangle.right), bottom: Math.min(window.innerHeight, rectangle.bottom) };
    const coordinate = point(event);
    const scale = graph.viewport.scale;
    const x = (coordinate.x - graph.viewport.x) / scale;
    const y = (coordinate.y - graph.viewport.y) / scale;
    const halfWidth = NODE_TARGET_PX / (2 * Math.hypot(matrix.a, matrix.b) * scale);
    const halfHeight = NODE_TARGET_PX / (2 * Math.hypot(matrix.c, matrix.d) * scale);
    let nearest: Exploration["nodes"][number] | undefined;
    let distance = Infinity;
    for (const node of graph.nodes) {
      const radius = node.id === graph.rootId ? 29 : 23;
      const symbolX = node.kind === "entity" ? radius : 17;
      const symbolY = node.kind === "entity" ? radius : 15;
      const canvasX = graph.viewport.x + node.x * scale;
      const canvasY = graph.viewport.y + node.y * scale;
      const centerX = matrix.a * canvasX + matrix.c * canvasY + matrix.e;
      const centerY = matrix.b * canvasX + matrix.d * canvasY + matrix.f;
      const visibleX = scale * (Math.abs(matrix.a) * symbolX + Math.abs(matrix.c) * symbolY);
      const visibleY = scale * (Math.abs(matrix.b) * symbolX + Math.abs(matrix.d) * symbolY);
      if (centerX + visibleX < bounds.left || centerX - visibleX > bounds.right || centerY + visibleY < bounds.top || centerY - visibleY > bounds.bottom) continue;
      const dx = x - node.x;
      const dy = y - node.y;
      const inTarget = Math.abs(dx) <= halfWidth && Math.abs(dy) <= halfHeight;
      const inSymbol = node.kind === "entity" ? dx * dx + dy * dy <= radius * radius : Math.abs(dx) <= 17 && Math.abs(dy) <= 15;
      if (!inTarget && !inSymbol) continue;
      const nextDistance = (event.clientX - centerX) ** 2 + (event.clientY - centerY) ** 2;
      if (nextDistance < distance || (nextDistance === distance && nearest && node.id < nearest.id)) { nearest = node; distance = nextDistance; }
    }
    return nearest;
  };
  const startDrag = (event: PointerEvent<SVGSVGElement>) => {
    suppressClick.current = false;
    if (event.button !== 0 || nearestNode(event)) return;
    const coordinate = point(event);
    drag.current = { pointerId: event.pointerId, x: coordinate.x, y: coordinate.y, clientX: event.clientX, clientY: event.clientY, moved: false, viewport: graph.viewport };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const stopDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    suppressClick.current = drag.current.moved;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const coordinate = svg.createSVGPoint();
      coordinate.x = event.clientX;
      coordinate.y = event.clientY;
      const matrix = svg.getScreenCTM();
      const center = matrix ? coordinate.matrixTransform(matrix.inverse()) : { x: 450, y: 280 };
      onViewportChange(zoomGraphViewport(graph.viewport, event.deltaY < 0 ? 1.1 : 1 / 1.1, center));
    };
    // React's wheel listener is passive; this scoped listener also prevents
    // the browser from zooming the whole page while the graph is manipulated.
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [graph.viewport, onViewportChange]);

  return (
    <div className="graph-viewport">
      <div className="graph-toolbar" aria-label="图谱视图操作">
        <button type="button" onClick={() => onViewportChange(zoomGraphViewport(graph.viewport, 1.25))} aria-label="放大图谱">＋</button>
        <button type="button" onClick={() => onViewportChange(zoomGraphViewport(graph.viewport, .8))} aria-label="缩小图谱">−</button>
        <button type="button" onClick={() => onViewportChange(fitGraphViewport(graph.nodes))}>适应视图</button>
        <span>{Math.round(graph.viewport.scale * 100)}%</span>
      </div>
      <svg
        ref={svgRef}
        viewBox="0 0 900 560"
        className="graph-svg"
        role="group"
        tabIndex={0}
        aria-label={`探索图谱，共 ${graph.nodes.length} 个节点。Tab 选择节点，Enter 展开实体或阅读新闻；方向键移动视图，加减键缩放，Home 适应视图。`}
        data-testid="knowledge-graph-canvas"
        onPointerDown={startDrag}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) { setHovered(nearestNode(event)?.label ?? ""); return; }
          if (Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) > 4) current.moved = true;
          const coordinate = point(event);
          onViewportChange({ ...current.viewport, x: current.viewport.x + coordinate.x - current.x, y: current.viewport.y + coordinate.y - current.y });
        }}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onPointerLeave={() => setHovered("")}
        onClickCapture={(event) => {
          event.stopPropagation();
          if (suppressClick.current) { suppressClick.current = false; return; }
          // Pointer selection uses screen distance, not SVG painting order when
          // the fixed touch targets overlap. AT clicks keep their named target.
          const targetId = (event.target as Element).closest("[data-node]")?.getAttribute("data-node");
          const node = event.detail === 0 ? targetId && byId.get(targetId) : nearestNode(event);
          if (!node) return;
          svgRef.current?.querySelector<SVGGElement>(`[data-node="${CSS.escape(node.id)}"]`)?.focus({ preventScroll: true });
          selectNode(node);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const moves: Record<string, [number, number]> = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
          const move = moves[event.key];
          if (move) onViewportChange({ ...graph.viewport, x: graph.viewport.x + move[0], y: graph.viewport.y + move[1] });
          else if (event.key === "+" || event.key === "=") onViewportChange(zoomGraphViewport(graph.viewport, 1.25));
          else if (event.key === "-") onViewportChange(zoomGraphViewport(graph.viewport, .8));
          else if (event.key === "Home") onViewportChange(fitGraphViewport(graph.nodes));
          else return;
          event.preventDefault();
        }}
      >
        <g transform={`translate(${graph.viewport.x} ${graph.viewport.y}) scale(${graph.viewport.scale})`}>
          {graph.edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            return from && to ? <line className={`graph-edge graph-edge-${edge.kind}`} key={`${edge.kind}:${edge.from}:${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}><title>{edge.label}</title></line> : null;
          })}
          {graph.nodes.map((node) => {
            const isRoot = node.id === graph.rootId;
            const selected = node.id === graph.focusId || node.newsId === graph.newsId;
            const expanded = graph.branches.some((branch) => branch.entityId === node.id);
            return (
              <g
                key={node.id}
                data-node={node.id}
                data-kind={node.kind}
                data-news-id={node.newsId || undefined}
                role="button"
                tabIndex={0}
                className={`graph-node ${node.kind} ${isRoot ? "graph-node-root" : ""} ${selected ? "graph-node-focus" : ""}`}
                aria-label={node.kind === "entity" ? `${node.label}，${expanded ? "查看当前实体" : "展开相关新闻"}${isRoot ? "，探索起点" : ""}` : `阅读新闻：${node.label}`}
                aria-pressed={selected}
                transform={`translate(${node.x} ${node.y})`}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node); }
                  else if (event.key === "Escape") { event.preventDefault(); svgRef.current?.focus(); }
                }}
                onFocus={() => setHovered(node.label)}
                onBlur={() => setHovered("")}
              >
                <title>{node.label}</title>
                <rect data-hit-target aria-hidden="true" x={-hitWidth / 2} y={-hitHeight / 2} width={hitWidth} height={hitHeight} style={{ fill: "transparent", stroke: "none", pointerEvents: "all", transition: "none" }} />
                {node.kind === "entity" ? <circle data-node-symbol r={isRoot ? 29 : 23} fill={typeColors.get(node.type) ?? "#64748b"} /> : <rect data-node-symbol x={-17} y={-15} width={34} height={30} rx={8} fill={typeColors.get(node.type) ?? "#64748b"} />}
                {isRoot && <text y={4} textAnchor="middle" className="graph-node-symbol" fill="white">起</text>}
                {!isRoot && node.kind === "entity" && <text y={4} textAnchor="middle" className="graph-node-symbol" fill="white">{expanded ? "✓" : "+"}</text>}
                {node.kind === "event" && <text y={4} textAnchor="middle" className="graph-node-symbol" fill="white">闻</text>}
                <text y={node.kind === "entity" ? 43 : 33} textAnchor="middle" className="graph-node-label">{node.label.length > 13 ? `${node.label.slice(0, 13)}…` : node.label}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="graph-legend">
        <span>● 实体：点击展开</span><span>▣ 新闻：点击阅读</span><span>虚线为报道提及，实线为报道时序</span>
      </div>
      <div className="graph-exploration-status">
        {/* Node blur must not shift the branch buttons between pointerdown and click. */}
        <div aria-live="polite" title={hovered || undefined} style={{ minHeight: "1.7em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hovered || "Tab 选择节点，Enter 展开或阅读。"}</div>
        <div>拖动空白处移动视图；按住 Ctrl / ⌘ 并滚动缩放。</div>
      </div>
    </div>
  );
}
