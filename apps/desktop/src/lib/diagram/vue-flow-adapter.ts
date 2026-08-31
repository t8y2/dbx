import type { DiagramTable, DiagramRelationship } from "./erDiagram";
import type { InferredRelationship, DiagramNode, DiagramEdge, DiagramLayer } from "@/types/diagram";
import type { Node, Edge } from "@vue-flow/core";
import { useLayerStore } from "./layer-store";
import { CARD_WIDTH, tableCardHeight } from "./diagram-constants";
import { handlesFromWaypoints, type Point } from "./edge-obstacle-router";

const LAYER_Z_INDEX = 0;
const TABLE_Z_INDEX = 10;

export type RelationshipEdgeData = {
  relationship: DiagramRelationship | InferredRelationship;
  waypoints?: Point[];
};

/** Table is on canvas when unlayered, or when its layer is visible. */
export function isTableCanvasVisible(tableName: string, layers: DiagramLayer[]): boolean {
  const layer = layers.find((l) => l.tableNames.includes(tableName));
  if (!layer) return true;
  return layer.visible;
}

/** positions are absolute canvas coordinates; converted to relative when parented to a visible layer */
export function toVueFlowNodes(tables: DiagramTable[], positions?: Record<string, { x: number; y: number }>): Node<{ table: DiagramTable }>[] {
  const layerStore = useLayerStore();
  const layers = layerStore.layers;

  return tables
    .filter((table) => !table.pendingDrop && isTableCanvasVisible(table.name, layers))
    .map((table) => {
      const layer = layerStore.getLayerByTable(table.name);
      const absolute = positions?.[table.name] || { x: 0, y: 0 };
      const visibleParent = layer?.visible ? layer : undefined;
      const layerPos = visibleParent?.position || { x: 0, y: 0 };
      const relative = visibleParent ? { x: absolute.x - layerPos.x, y: absolute.y - layerPos.y } : absolute;

      return {
        id: table.name,
        type: "table",
        position: relative,
        parentNode: visibleParent?.id,
        expandParent: false,
        zIndex: TABLE_Z_INDEX,
        data: { table },
      };
    });
}

export function toDiagramNodes(vueFlowNodes: Node<{ table: DiagramTable }>[]): DiagramNode[] {
  return vueFlowNodes
    .filter((node) => (node.type === "table" || !node.type) && node.data?.table)
    .map((node) => ({
      id: node.id,
      type: node.type || "table",
      position: node.position,
      data: { table: node.data!.table },
    }));
}

/** Pick L/R or T/B handles from table center deltas. */
export function pickHandles(sourcePos: { x: number; y: number } | undefined, targetPos: { x: number; y: number } | undefined, sourceHeight = 120, targetHeight = 120, cardWidth = CARD_WIDTH): { sourceHandle: string; targetHandle: string } {
  if (!sourcePos || !targetPos) {
    return { sourceHandle: "right", targetHandle: "left-target" };
  }
  const scx = sourcePos.x + cardWidth / 2;
  const scy = sourcePos.y + sourceHeight / 2;
  const tcx = targetPos.x + cardWidth / 2;
  const tcy = targetPos.y + targetHeight / 2;
  const dx = tcx - scx;
  const dy = tcy - scy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) return { sourceHandle: "right", targetHandle: "left-target" };
    return { sourceHandle: "left", targetHandle: "right-target" };
  }
  if (dy >= 0) return { sourceHandle: "bottom", targetHandle: "top-target" };
  return { sourceHandle: "top", targetHandle: "bottom-target" };
}

export function toVueFlowEdges(
  relationships: (DiagramRelationship | InferredRelationship)[],
  positions?: Record<string, { x: number; y: number }>,
  waypointsById?: Record<string, Point[]>,
  tableHeights?: Record<string, number>,
  handleHintsById?: Record<string, { sourceHandle?: string; targetHandle?: string }>,
): Edge<RelationshipEdgeData>[] {
  const layers = useLayerStore().layers;

  return relationships
    .filter((rel) => isTableCanvasVisible(rel.sourceTable, layers) && isTableCanvasVisible(rel.targetTable, layers))
    .map((rel) => {
      const sourceHeight = tableHeights?.[rel.sourceTable] ?? tableCardHeight(0);
      const targetHeight = tableHeights?.[rel.targetTable] ?? tableCardHeight(0);
      const waypoints = waypointsById?.[rel.id];
      const fromWaypoints = waypoints?.length ? handlesFromWaypoints(waypoints) : null;
      const hint = handleHintsById?.[rel.id];
      const picked = pickHandles(positions?.[rel.sourceTable], positions?.[rel.targetTable], sourceHeight, targetHeight);
      const sourceHandle = fromWaypoints?.sourceHandle || hint?.sourceHandle || picked.sourceHandle;
      const targetHandle = fromWaypoints?.targetHandle || hint?.targetHandle || picked.targetHandle;
      return {
        id: rel.id,
        type: "relationship",
        source: rel.sourceTable,
        target: rel.targetTable,
        sourceHandle,
        targetHandle,
        class: "relationship-edge",
        selectable: true,
        interactionWidth: 24,
        data: {
          relationship: rel,
          ...(waypoints?.length ? { waypoints } : {}),
        },
      };
    });
}

export function toDiagramEdges(vueFlowEdges: Edge<RelationshipEdgeData>[]): DiagramEdge[] {
  return vueFlowEdges
    .filter((edge) => edge.data?.relationship)
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? undefined,
      targetHandle: edge.targetHandle ?? undefined,
      waypoints: edge.data?.waypoints,
      data: { relationship: edge.data!.relationship },
    }));
}

export function toVueFlowLayerNodes(layers: DiagramLayer[]): Node<{ layer: DiagramLayer }>[] {
  return layers
    .filter((layer) => layer.visible)
    .map((layer) => ({
      id: layer.id,
      type: "layer",
      position: layer.position || { x: 0, y: 0 },
      width: layer.width || 240,
      height: layer.height || 52,
      zIndex: LAYER_Z_INDEX,
      draggable: true,
      selectable: true,
      dragHandle: ".layer-drag-handle",
      data: { layer },
      style: {
        width: `${layer.width || 240}px`,
        height: `${layer.height || 52}px`,
        pointerEvents: "none",
      },
    }));
}

/** Convert Vue Flow node position (possibly relative) to absolute canvas coords */
export function toAbsolutePosition(nodeId: string, relativeOrAbsolute: { x: number; y: number }, layers: DiagramLayer[]): { x: number; y: number } {
  const layer = layers.find((l) => l.id === nodeId);
  if (layer) return relativeOrAbsolute;

  const parent = layers.find((l) => l.visible && l.tableNames.includes(nodeId));
  if (parent?.position) {
    return {
      x: parent.position.x + relativeOrAbsolute.x,
      y: parent.position.y + relativeOrAbsolute.y,
    };
  }
  return relativeOrAbsolute;
}
