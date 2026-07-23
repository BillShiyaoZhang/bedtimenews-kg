"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Event, KnowledgeBase, Ontology } from "../lib/kg";

type GraphNode = {
  id: string;
  label: string;
  kind: "entity" | "event";
  type: string;
  x: number;
  y: number;
  radius: number;
};

type GraphEdge = {
  from: string;
  to: string;
  kind: "mention" | "relation";
};

type KnowledgeGraphCanvasProps = {
  kg: KnowledgeBase;
  ontology: Ontology;
  selectedEntityId: string;
  selectedEventId: string;
  onSelectEntity: (id: string) => void;
  onSelectEvent: (id: string) => void;
};

export function KnowledgeGraphCanvas({
  kg,
  ontology,
  selectedEntityId,
  selectedEventId,
  onSelectEntity,
  onSelectEvent,
}: KnowledgeGraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  const graph = useMemo(() => {
    const selectedEvents = kg.events
      .filter((event) => event.entityIds.includes(selectedEntityId))
      .sort((a, b) => a.date.localeCompare(b.date));
    const eventIds = new Set(selectedEvents.map((event) => event.id));
    const supportingEntityIds = Array.from(
      new Set(
        selectedEvents.flatMap((event) =>
          event.entityIds.filter((id) => id !== selectedEntityId),
        ),
      ),
    ).slice(0, 7);

    return {
      events: selectedEvents,
      entities: kg.entities.filter(
        (entity) =>
          entity.id === selectedEntityId ||
          supportingEntityIds.includes(entity.id),
      ),
      relations: kg.eventRelations.filter(
        (relation) =>
          eventIds.has(relation.from) && eventIds.has(relation.to),
      ),
    };
  }, [kg, selectedEntityId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;

    const draw = () => {
      const rect = wrapper.getBoundingClientRect();
      const width = Math.max(320, rect.width);
      const height = Math.max(430, rect.height);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const eventOrbit = Math.min(width * 0.32, 230);
      const entityOrbit = Math.min(width * 0.44, 330);
      const nodes: GraphNode[] = [];

      const mainEntity = graph.entities.find(
        (entity) => entity.id === selectedEntityId,
      );
      if (mainEntity) {
        nodes.push({
          id: mainEntity.id,
          label: mainEntity.label,
          kind: "entity",
          type: mainEntity.type,
          x: centerX,
          y: centerY,
          radius: 33,
        });
      }

      graph.events.forEach((event, index) => {
        const angle =
          -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(graph.events.length, 1);
        nodes.push({
          id: event.id,
          label: event.title,
          kind: "event",
          type: event.type,
          x: centerX + Math.cos(angle) * eventOrbit,
          y: centerY + Math.sin(angle) * eventOrbit,
          radius: event.id === selectedEventId ? 25 : 20,
        });
      });

      graph.entities
        .filter((entity) => entity.id !== selectedEntityId)
        .forEach((entity, index, entities) => {
          const angle =
            Math.PI / 7 +
            (Math.PI * 2 * index) / Math.max(entities.length, 1);
          nodes.push({
            id: entity.id,
            label: entity.label,
            kind: "entity",
            type: entity.type,
            x: centerX + Math.cos(angle) * entityOrbit,
            y: centerY + Math.sin(angle) * entityOrbit * 0.82,
            radius: 16,
          });
        });

      const edges: GraphEdge[] = [];
      graph.events.forEach((event) => {
        edges.push({
          from: selectedEntityId,
          to: event.id,
          kind: "mention",
        });
        event.entityIds
          .filter((entityId) =>
            graph.entities.some((entity) => entity.id === entityId),
          )
          .filter((entityId) => entityId !== selectedEntityId)
          .forEach((entityId) => {
            edges.push({ from: entityId, to: event.id, kind: "mention" });
          });
      });
      graph.relations.forEach((relation) => {
        edges.push({
          from: relation.from,
          to: relation.to,
          kind: "relation",
        });
      });

      context.lineCap = "round";
      edges.forEach((edge) => {
        const from = nodes.find((node) => node.id === edge.from);
        const to = nodes.find((node) => node.id === edge.to);
        if (!from || !to) return;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.strokeStyle =
          edge.kind === "relation"
            ? "rgba(193, 81, 47, .58)"
            : "rgba(80, 75, 68, .22)";
        context.lineWidth = edge.kind === "relation" ? 2 : 1;
        context.setLineDash(edge.kind === "relation" ? [] : [3, 5]);
        context.stroke();
      });
      context.setLineDash([]);

      nodes.forEach((node) => {
        const typeColor =
          node.kind === "event"
            ? ontology.eventTypes.find((type) => type.id === node.type)?.color
            : ontology.entityTypes.find((type) => type.id === node.type)?.color;
        const color = typeColor ?? "#6a645b";
        const selected =
          node.id === selectedEntityId || node.id === selectedEventId;
        const hovered = hoveredNode?.id === node.id;

        context.beginPath();
        context.arc(node.x, node.y, node.radius + (hovered ? 3 : 0), 0, Math.PI * 2);
        context.fillStyle = selected ? color : `${color}e8`;
        context.fill();
        context.strokeStyle = selected ? "#fffaf1" : "rgba(255,255,255,.68)";
        context.lineWidth = selected ? 4 : 2;
        context.stroke();

        context.fillStyle = "#27231f";
        context.textAlign = "center";
        context.textBaseline = "top";
        context.font =
          node.id === selectedEntityId
            ? "600 13px system-ui, sans-serif"
            : "500 11px system-ui, sans-serif";
        const label =
          node.kind === "event" && node.label.length > 12
            ? `${node.label.slice(0, 12)}…`
            : node.label;
        context.fillText(label, node.x, node.y + node.radius + 8);
      });

      nodesRef.current = nodes;
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [
    graph,
    hoveredNode?.id,
    ontology,
    selectedEntityId,
    selectedEventId,
  ]);

  const nodeAtPoint = (event: {
    currentTarget: HTMLCanvasElement;
    clientX: number;
    clientY: number;
  }): GraphNode | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return (
      nodesRef.current.find(
        (node) => Math.hypot(node.x - x, node.y - y) <= node.radius + 7,
      ) ?? null
    );
  };

  const selectNode = (node: GraphNode | null) => {
    if (!node) return;
    if (node.kind === "event") onSelectEvent(node.id);
    else onSelectEntity(node.id);
  };

  return (
    <div className="graph-canvas-wrap" ref={wrapperRef}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`以 ${
          kg.entities.find((entity) => entity.id === selectedEntityId)?.label
        } 为中心的知识图谱，包含 ${graph.events.length} 个事件和 ${
          graph.entities.length
        } 个实体。`}
        data-testid="knowledge-graph-canvas"
        onPointerMove={(event) => {
          const node = nodeAtPoint(event);
          setHoveredNode((current) =>
            current?.id === node?.id ? current : node,
          );
          event.currentTarget.style.cursor = node ? "pointer" : "default";
        }}
        onPointerLeave={() => setHoveredNode(null)}
        onClick={(event) => selectNode(nodeAtPoint(event))}
      />
      <div className="graph-legend" aria-hidden="true">
        <span><i className="legend-dot entity-dot" />实体</span>
        <span><i className="legend-dot event-dot" />事件</span>
        <span><i className="legend-line relation-line" />历史关联</span>
      </div>
      {hoveredNode ? (
        <div className="graph-tooltip" aria-live="polite">
          <span>{hoveredNode.kind === "event" ? "事件" : "实体"}</span>
          <strong>{hoveredNode.label}</strong>
        </div>
      ) : null}
      <div className="sr-only">
        {graph.events.map((event: Event) => (
          <button key={event.id} onClick={() => onSelectEvent(event.id)}>
            查看事件：{event.title}
          </button>
        ))}
      </div>
    </div>
  );
}
