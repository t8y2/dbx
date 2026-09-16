<script setup lang="ts">
import { computed, inject, type Ref, type ComputedRef } from "vue";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@vue-flow/core";
import type { DiagramRelationship } from "@/lib/diagram/erDiagram";
import type { InferredRelationship } from "@/types/diagram";
import { DIAGRAM_HOVERED_EDGE_KEY, DIAGRAM_EDGE_OBSTACLES_KEY, EDGE_ROUTE_OFFSET, EDGE_STROKE_IDLE, EDGE_STROKE_HOVER } from "@/lib/diagram/diagram-constants";
import type { RelationshipEdgeData } from "@/lib/diagram/vue-flow-adapter";
import { alignWaypointsToEndpoints, endpointRectsFromObstacles, pathSkimsEndpoints, pointAlongPolyline, pointsToSvgPath, polylineLength, routeOrthogonalAroundObstacles, type ObstacleRect, type Point } from "@/lib/diagram/edge-obstacle-router";

const HOVER_BLUE = "#2563eb";
/** Prefer live obstacle routing when it is at most this fraction of aligned ELK path length. */
const LIVE_ROUTE_LENGTH_RATIO = 0.85;
/** Cardinality badge positions along the edge (arc-length fraction). */
const SOURCE_CARDINALITY_T = 0.18;
const TARGET_CARDINALITY_T = 0.82;

const props = defineProps<EdgeProps<RelationshipEdgeData>>();

const hoveredEdgeId = inject<Ref<string | null> | null>(DIAGRAM_HOVERED_EDGE_KEY, null);
const obstacles = inject<ComputedRef<ObstacleRect[]> | Ref<ObstacleRect[]> | null>(DIAGRAM_EDGE_OBSTACLES_KEY, null);
const isHovered = computed(() => hoveredEdgeId?.value === props.id);

function isDiagramRelationship(rel: DiagramRelationship | InferredRelationship): rel is DiagramRelationship {
  return "kind" in rel;
}

function snapRoutedToHandles(points: Point[]): Point[] {
  if (points.length < 2) return points;
  const snapped = points.map((p) => ({ ...p }));
  snapped[0] = { x: props.sourceX, y: props.sourceY };
  snapped[snapped.length - 1] = { x: props.targetX, y: props.targetY };
  return snapped;
}

function buildRoutedPoints(): Point[] | null {
  const obstacleList = obstacles?.value ?? [];
  const endpointIds: [string, string] = [props.source, props.target];
  const endpointRects = endpointRectsFromObstacles(obstacleList, endpointIds);

  const live = routeOrthogonalAroundObstacles({
    source: { x: props.sourceX, y: props.sourceY },
    target: { x: props.targetX, y: props.targetY },
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    obstacles: obstacleList,
    endpointIds,
    offset: EDGE_ROUTE_OFFSET,
  });

  const stored = props.data?.waypoints;
  let aligned: Point[] | null = null;
  if (stored?.length) {
    aligned = alignWaypointsToEndpoints(stored, props.sourceX, props.sourceY, props.targetX, props.targetY, {
      obstacles: obstacleList,
      endpointIds,
    });
    // Drop ELK paths that skim endpoint table borders (align also rejects when obstacles present)
    if (aligned?.length && pathSkimsEndpoints(aligned, endpointRects)) {
      aligned = null;
    }
  }

  if (aligned?.length && live?.length) {
    const alignedLen = polylineLength(aligned);
    const liveLen = polylineLength(live);
    if (alignedLen > 0 && liveLen <= alignedLen * LIVE_ROUTE_LENGTH_RATIO) {
      return snapRoutedToHandles(live);
    }
    return snapRoutedToHandles(aligned);
  }
  if (aligned?.length) return snapRoutedToHandles(aligned);
  if (live?.length) return snapRoutedToHandles(live);
  return null;
}

const pathResult = computed(() => {
  const routed = buildRoutedPoints();
  if (routed?.length) {
    return {
      path: pointsToSvgPath(routed),
      points: routed,
    };
  }

  const [path] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    borderRadius: 0,
    offset: EDGE_ROUTE_OFFSET,
  });
  // Smooth-step fallback: approximate with endpoint → mid → endpoint for badge placement
  const mid = {
    x: (props.sourceX + props.targetX) / 2,
    y: (props.sourceY + props.targetY) / 2,
  };
  return {
    path,
    points: [{ x: props.sourceX, y: props.sourceY }, mid, { x: props.targetX, y: props.targetY }],
  };
});

const path = computed(() => pathResult.value.path);

const sourceBadgePos = computed(() => pointAlongPolyline(pathResult.value.points, SOURCE_CARDINALITY_T));
const targetBadgePos = computed(() => pointAlongPolyline(pathResult.value.points, TARGET_CARDINALITY_T));

const idleStroke = computed(() => {
  const rel = props.data?.relationship;
  if (!rel) {
    return "color-mix(in srgb, var(--muted-foreground) 45%, transparent)";
  }
  if (isDiagramRelationship(rel)) {
    if (rel.kind === "foreign-key") {
      return "color-mix(in srgb, var(--primary) 55%, transparent)";
    }
    if (rel.kind === "custom") {
      return "color-mix(in srgb, var(--primary) 70%, transparent)";
    }
  }
  return "color-mix(in srgb, var(--muted-foreground) 45%, transparent)";
});

const strokeColor = computed(() => (isHovered.value ? HOVER_BLUE : idleStroke.value));
const strokeWidth = computed(() => (isHovered.value ? EDGE_STROKE_HOVER : EDGE_STROKE_IDLE));

const strokeDasharray = computed(() => {
  const rel = props.data?.relationship;
  if (rel && isDiagramRelationship(rel) && (rel.kind === "foreign-key" || rel.kind === "custom")) {
    return "none";
  }
  return "5,5";
});

const sourceCardinality = computed(() => {
  const rel = props.data?.relationship;
  if (rel && isDiagramRelationship(rel) && rel.sourceCardinality) return rel.sourceCardinality;
  return "N";
});

const targetCardinality = computed(() => {
  const rel = props.data?.relationship;
  if (rel && isDiagramRelationship(rel) && rel.targetCardinality) return rel.targetCardinality;
  return "1";
});

const badgeClass = computed(() => (isHovered.value ? "border-blue-500 text-blue-600" : "border-border/80 text-foreground"));
</script>

<template>
  <BaseEdge
    :id="id"
    :path="path"
    :interaction-width="28"
    :style="{
      stroke: strokeColor,
      strokeWidth: strokeWidth,
      strokeDasharray: strokeDasharray === 'none' ? undefined : strokeDasharray,
    }"
  />
  <EdgeLabelRenderer>
    <div
      class="nopan nodrag pointer-events-none absolute z-10 min-w-[1.1rem] rounded border bg-background/95 px-1 py-0.5 text-center font-mono text-[10px] font-semibold leading-none shadow-sm"
      :class="badgeClass"
      :style="{
        transform: `translate(-50%, -50%) translate(${sourceBadgePos.x}px, ${sourceBadgePos.y}px)`,
      }"
    >
      {{ sourceCardinality }}
    </div>
    <div
      class="nopan nodrag pointer-events-none absolute z-10 min-w-[1.1rem] rounded border bg-background/95 px-1 py-0.5 text-center font-mono text-[10px] font-semibold leading-none shadow-sm"
      :class="badgeClass"
      :style="{
        transform: `translate(-50%, -50%) translate(${targetBadgePos.x}px, ${targetBadgePos.y}px)`,
      }"
    >
      {{ targetCardinality }}
    </div>
  </EdgeLabelRenderer>
</template>

<style>
.diagram-flow .vue-flow__edge.relationship-edge,
.diagram-flow .vue-flow__edge.relationship-edge.inactive {
  pointer-events: stroke !important;
  cursor: pointer;
}

.diagram-flow .vue-flow__edge.relationship-edge .vue-flow__edge-interaction {
  stroke: #000 !important;
  stroke-opacity: 0 !important;
  pointer-events: stroke !important;
}

.diagram-flow .vue-flow__edge.relationship-edge:hover .vue-flow__edge-path,
.diagram-flow .vue-flow__edge.relationship-edge.updating .vue-flow__edge-path {
  stroke: #2563eb !important;
  stroke-width: 3.5px !important;
}

.diagram-flow .vue-flow__node-layer {
  pointer-events: none !important;
}

.diagram-flow .vue-flow__node-layer .layer-drag-handle {
  pointer-events: auto !important;
}
</style>
