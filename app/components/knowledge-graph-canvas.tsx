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

const MAX_GRAPH_EVENTS = 18;
const MAX_SUPPORTING_ENTITIES = 8;

function sampleEvents(events: Event[], selectedEventId: string) {
  if (events.length <= MAX_GRAPH_EVENTS) return events;
  const sampled = Array.from({ length: MAX_GRAPH_EVENTS }, (_, index) => {
    const position = Math.round(
      (index * (events.length - 1)) / (MAX_GRAPH_EVENTS - 1),
    );
    return events[position];
  });
  const selected = events.find((event) => event.id === selectedEventId);
  if (selected && !sampled.some((event) => event.id === selected.id)) {
    sampled[MAX_GRAPH_EVENTS - 2] = selected;
  }
  return Array.from(new Map(sampled.map((event) => [event.id, event])).values())
    .sort((left, right) => left.date.localeCompare(right.date));
}

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
    const allEvents = kg.events
      .filter((event) => event.entityIds.includes(selectedEntityId))
      .sort((left, right) => left.date.localeCompare(right.date));
    const events = sampleEvents(allEvents, selectedEventId);
    const eventIds = new Set(events.map((event) => event.id));
    const supportingCounts = new Map<string, number>();

    for (const event of events) {
      for (const entityId of event.entityIds) {
        if (entityId !== selectedEntityId) {
          supportingCounts.set(
            entityId,
            (supportingCounts.get(entityId) ?? 0) + 1,
          );
        }
      }
    }

    const supportingEntityIds = Array.from(supportingCounts)
      .sort(
        ([leftId, leftCount], [rightId, rightCount]) =>
          rightCount - leftCount ||
          (kg.entities.find((entity) => entity.id === leftId)?.label ?? "")
            .localeCompare(
              kg.entities.find((entity) => entity.id === rightId)?.label ?? "",
              "zh-CN",
            ),
      )
      .slice(0, MAX_SUPPORTING_ENTITIES)
      .map(([id]) => id);

    return {
      allEventCount: allEvents.length,
      events,
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
  }, [kg, selectedEntityId, selectedEventId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;

    const draw = () => {
      const rect = wrapper.getBoundingClientRect();
      const width = Math.max(320, rect.width);
      const height = Math.max(480, rect.height);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const eventOrbitX = Math.min(width * 0.29, 240);
      const eventOrbitY = Math.min(height * 0.29, 180);
      const entityOrbitX = Math.min(width * 0.44, 355);
      const entityOrbitY = Math.min(height * 0.41, 245);
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
          radius: 34,
        });
      }

      graph.events.forEach((event, index) => {
        const angle =
          -Math.PI / 2 +
          (Math.PI * 2 * index) / Math.max(graph.events.length, 1);
        nodes.push({
          id: event.id,
          label: event.title,
          kind: "event",
          type: event.type,
          x: centerX + Math.cos(angle) * eventOrbitX,
          y: centerY + Math.sin(angle) * eventOrbitY,
          radius: event.id === selectedEventId ? 25 : 19,
        });
      });

      graph.entities
        .filter((entity) => entity.id !== selectedEntityId)
        .forEach((entity, index, entities) => {
          const angle =
            Math.PI / 8 +
            (Math.PI * 2 * index) / Math.max(entities.length, 1);
          nodes.push({
            id: entity.id,
            label: entity.label,
            kind: "entity",
            type: entity.type,
            x: centerX + Math.cos(angle) * entityOrbitX,
            y: centerY + Math.sin(angle) * entityOrbitY,
            radius: 15,
          });
        });

      const visibleNodeIds = new Set(nodes.map((node) => node.id));
      const edges: GraphEdge[] = [];
      graph.events.forEach((event) => {
        edges.push({
          from: selectedEntityId,
          to: event.id,
          kind: "mention",
        });
        event.entityIds
          .filter(
            (entityId) =>
              entityId !== selectedEntityId &&
              visibleNodeIds.has(entityId),
          )
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
            ? "rgba(200, 115, 55, .72)"
            : "rgba(36, 77, 60, .20)";
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
        context.arc(
          node.x,
          node.y,
          node.radius + (hovered ? 3 : 0),
          0,
          Math.PI * 2,
        );
        context.fillStyle = selected ? color : `${color}e6`;
        context.fill();
        context.strokeStyle = selected ? "#fffdf8" : "rgba(255,255,255,.74)";
        context.lineWidth = selected ? 4 : 2;
        context.stroke();

        context.fillStyle = "#17211d";
        context.textAlign = "center";
        context.textBaseline = "top";
        context.font =
          node.id === selectedEntityId
            ? "700 13px system-ui, sans-serif"
            : "600 10px system-ui, sans-serif";
        const maxLength = node.kind === "event" ? 11 : 8;
        const label =
          node.label.length > maxLength
            ? `${node.label.slice(0, maxLength)}…`
            : node.label;
        context.fillText(label, node.x, node.y + node.radius + 7);
      });

      nodesRef.current = nodes;
    };

    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
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
        } 为中心的知识图谱。共关联 ${graph.allEventCount} 个事件，当前抽样展示 ${
          graph.events.length
        } 个事件节点和 ${graph.entities.length} 个实体节点。`}
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
        <span>
          <i className="legend-dot entity-dot" />
          实体
        </span>
        <span>
          <i className="legend-dot event-dot" />
          事件
        </span>
        <span>
          <i className="legend-line relation-line" />
          时序关系
        </span>
      </div>
      {graph.allEventCount > graph.events.length ? (
        <p className="graph-sample-note">
          为保持可读性，按时间均匀抽样展示 {graph.events.length} /{" "}
          {graph.allEventCount} 个关联事件。
        </p>
      ) : null}
      {hoveredNode ? (
        <div className="graph-tooltip" aria-live="polite">
          <span>{hoveredNode.kind === "event" ? "事件" : "实体"}</span>
          <strong>{hoveredNode.label}</strong>
        </div>
      ) : null}
      <div className="sr-only">
        {graph.events.map((event) => (
          <button key={event.id} onClick={() => onSelectEvent(event.id)}>
            查看事件：{event.title}
          </button>
        ))}
      </div>
    </div>
  );
}
