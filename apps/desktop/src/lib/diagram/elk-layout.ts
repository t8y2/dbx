import ELK from "elkjs/lib/elk.bundled.js";
import type { LayoutOptions, DiagramNode, DiagramEdge, DiagramLayer } from "@/types/diagram";
import { CARD_WIDTH, COLUMN_ROW_HEIGHT, CARD_HEADER_HEIGHT, CARD_BOTTOM_PADDING, LAYER_PADDING, LAYER_HEADER_HEIGHT } from "./diagram-constants";
import { handlesFromWaypoints, type Point } from "./edge-obstacle-router";

const elk = new ELK();

export interface ElkNode {
  id: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  labels?: { text: string }[];
  layoutOptions?: Record<string, string>;
}

export interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  sections?: {
    id?: string;
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: { x: number; y: number }[];
  }[];
}

export interface ElkGraph {
  id: string;
  children: ElkNode[];
  edges: ElkEdge[];
  layoutOptions?: Record<string, string>;
}

export interface LayerLayoutInfo {
  layerId: string;
  layerName: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function calculateTableHeight(tableColumns: unknown[]): number {
  return CARD_HEADER_HEIGHT + tableColumns.length * COLUMN_ROW_HEIGHT + CARD_BOTTOM_PADDING;
}

export async function computeLayout(nodes: DiagramNode[], edges: DiagramEdge[], options: LayoutOptions = {}): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] }> {
  const elkGraph = buildElkGraph(nodes, edges);
  const elkOptions = buildElkOptions(options);

  const result = (await elk.layout({
    ...elkGraph,
    layoutOptions: elkOptions,
  } as Parameters<typeof elk.layout>[0])) as ElkGraph;

  return extractLayoutResult(result, nodes, edges);
}

/**
 * Layout with layers.
 * - auto layers: nested in ELK hierarchy (children get relative coords on write-back)
 * - free layers: tables keep existing absolute positions; layer box is size-to-fit after
 * - unassigned tables: laid out at root with auto layers
 */
export async function computeLayoutWithLayers(nodes: DiagramNode[], edges: DiagramEdge[], layers: DiagramLayer[], options: LayoutOptions = {}): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[]; layerLayouts: LayerLayoutInfo[] }> {
  const visibleLayers = layers.filter((l) => l.visible && l.tableNames.length > 0);
  const autoLayers = visibleLayers.filter((l) => (l.layoutMode ?? "auto") === "auto");
  const freeLayers = visibleLayers.filter((l) => (l.layoutMode ?? "auto") === "free");

  if (visibleLayers.length === 0) {
    const result = await computeLayout(nodes, edges, options);
    return { ...result, layerLayouts: [] };
  }

  const freeTableIds = new Set(freeLayers.flatMap((l) => l.tableNames));
  const nodesForElk = nodes.filter((n) => !freeTableIds.has(n.id));
  const edgesForElk = edges.filter((e) => !freeTableIds.has(e.source) && !freeTableIds.has(e.target));

  const positionMap = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    positionMap.set(node.id, { ...node.position });
  }

  const layerLayouts: LayerLayoutInfo[] = [];
  /** Edges that went through ELK, keyed by id (may include waypoints). */
  const elkEdgeById = new Map<string, DiagramEdge>();

  if (nodesForElk.length > 0) {
    const elkGraph = buildHierarchicalElkGraph(nodesForElk, edgesForElk, autoLayers);
    const elkOptions = buildElkOptions(options);
    const result = (await elk.layout({
      ...elkGraph,
      layoutOptions: elkOptions,
    } as Parameters<typeof elk.layout>[0])) as ElkGraph;

    const extracted = extractHierarchicalLayoutResult(result, nodesForElk, edgesForElk, autoLayers);
    for (const node of extracted.nodes) {
      positionMap.set(node.id, { ...node.position });
    }
    layerLayouts.push(...extracted.layerLayouts);
    for (const edge of extracted.edges) {
      elkEdgeById.set(edge.id, edge);
    }
  }

  // Free layers: keep table positions; compute size-to-fit boxes
  for (const layer of freeLayers) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hasAny = false;

    for (const tableName of layer.tableNames) {
      const node = nodes.find((n) => n.id === tableName);
      const pos = positionMap.get(tableName) || node?.position;
      if (!pos) continue;
      hasAny = true;
      const height = calculateTableHeight(node?.data?.table?.columns || []);
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + CARD_WIDTH);
      maxY = Math.max(maxY, pos.y + height);
    }

    if (!hasAny) continue;

    const x = minX - LAYER_PADDING;
    const y = minY - LAYER_HEADER_HEIGHT - LAYER_PADDING;
    const width = Math.max(160, maxX - minX + LAYER_PADDING * 2);
    const height = Math.max(100, maxY - minY + LAYER_HEADER_HEIGHT + LAYER_PADDING * 2);

    layerLayouts.push({
      layerId: layer.id,
      layerName: layer.name,
      color: layer.color,
      x,
      y,
      width,
      height,
    });
  }

  const newNodes = nodes.map((node) => ({
    ...node,
    position: positionMap.get(node.id) || node.position,
  }));

  const newEdges = edges.map((edge) => {
    const fromElk = elkEdgeById.get(edge.id);
    if (!fromElk) return edge;
    return {
      ...edge,
      waypoints: fromElk.waypoints,
      sourceHandle: fromElk.sourceHandle,
      targetHandle: fromElk.targetHandle,
    };
  });

  return {
    nodes: newNodes,
    edges: newEdges,
    layerLayouts,
  };
}

function buildElkGraph(nodes: DiagramNode[], edges: DiagramEdge[]): ElkGraph {
  const elkNodes: ElkNode[] = nodes.map((node) => ({
    id: node.id,
    width: CARD_WIDTH,
    height: calculateTableHeight(node.data?.table?.columns || []),
  }));

  const elkEdges: ElkEdge[] = edges.map((edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
  }));

  return {
    id: "diagram",
    children: elkNodes,
    edges: elkEdges,
  };
}

function buildHierarchicalElkGraph(nodes: DiagramNode[], edges: DiagramEdge[], autoLayers: DiagramLayer[]): ElkGraph {
  const elkLayers: ElkNode[] = [];
  const tableIdSet = new Set<string>();

  for (const layer of autoLayers) {
    const layerTables = nodes.filter((n) => layer.tableNames.includes(n.id));
    if (layerTables.length === 0) continue;

    const elkTableNodes = layerTables.map((tableNode) => ({
      id: tableNode.id,
      width: CARD_WIDTH,
      height: calculateTableHeight(tableNode.data?.table?.columns || []),
    }));

    layerTables.forEach((n) => tableIdSet.add(n.id));

    elkLayers.push({
      id: layer.id,
      width: 0,
      height: 0,
      children: elkTableNodes,
      labels: [{ text: layer.name }],
      layoutOptions: {
        "elk.padding": `[top=${LAYER_HEADER_HEIGHT + LAYER_PADDING},left=${LAYER_PADDING},bottom=${LAYER_PADDING},right=${LAYER_PADDING}]`,
      },
    });
  }

  const unassignedNodes = nodes.filter((n) => !tableIdSet.has(n.id));
  const unassignedElkNodes = unassignedNodes.map((node) => ({
    id: node.id,
    width: CARD_WIDTH,
    height: calculateTableHeight(node.data?.table?.columns || []),
  }));

  return {
    id: "diagram",
    children: [...elkLayers, ...unassignedElkNodes],
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
}

function buildElkOptions(options: LayoutOptions): Record<string, string> {
  const directionMap: Record<string, string> = {
    LR: "RIGHT",
    TB: "DOWN",
    RL: "LEFT",
    BT: "UP",
  };

  return {
    "elk.algorithm": "layered",
    "elk.direction": directionMap[options.direction || "LR"],
    "elk.layered.edgeRouting": "ORTHOGONAL",
    "elk.layered.nodePlacement": "BRANDES_KOEPF",
    "elk.layered.crossingMinimization": "LAYER_SWEEP",
    "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
    "elk.layered.separateConnectedComponents": "true",
    "elk.spacing.nodeNode": "60",
    "elk.spacing.layerLayer": "80",
    "elk.padding": `${LAYER_PADDING}`,
    "elk.layered.edgeSpacing": "20",
    "elk.layered.nodeSpacing": "50",
    "elk.layered.bendPointSpacing": "10",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  };
}

function extractLayoutResult(result: ElkGraph, originalNodes: DiagramNode[], originalEdges: DiagramEdge[]): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const nodePositionMap = new Map<string, { x: number; y: number }>();

  for (const child of result.children || []) {
    if (child.x !== undefined && child.y !== undefined) {
      nodePositionMap.set(child.id, { x: child.x, y: child.y });
    }
  }

  const edgeBendPoints = new Map<string, { x: number; y: number }[][]>();
  for (const edge of result.edges || []) {
    if (edge.sections) {
      const points: { x: number; y: number }[][] = [];
      for (const section of edge.sections) {
        const sectionPoints: { x: number; y: number }[] = [];
        sectionPoints.push(section.startPoint);
        if (section.bendPoints) {
          sectionPoints.push(...section.bendPoints);
        }
        sectionPoints.push(section.endPoint);
        points.push(sectionPoints);
      }
      edgeBendPoints.set(edge.id, points);
    }
  }

  const newNodes = originalNodes.map((node) => {
    const position = nodePositionMap.get(node.id);
    return {
      ...node,
      position: position || node.position,
    };
  });

  const newEdges = originalEdges.map((edge) => {
    const sections = edgeBendPoints.get(edge.id);
    const waypoints: Point[] | undefined = sections?.length ? sections.flatMap((section, index) => (index === 0 ? section : section.slice(1))) : undefined;
    const handles = waypoints ? handlesFromWaypoints(waypoints) : null;
    return {
      ...edge,
      waypoints,
      sourceHandle: handles?.sourceHandle,
      targetHandle: handles?.targetHandle,
    };
  });

  return {
    nodes: newNodes,
    edges: newEdges,
  };
}

/**
 * Write back ABSOLUTE positions for tables (parent absolute + child relative from ELK).
 * Adapter converts to relative for Vue Flow parentNode.
 */
function extractHierarchicalLayoutResult(result: ElkGraph, originalNodes: DiagramNode[], originalEdges: DiagramEdge[], layers: DiagramLayer[]): { nodes: DiagramNode[]; edges: DiagramEdge[]; layerLayouts: LayerLayoutInfo[] } {
  const absolutePositions = new Map<string, { x: number; y: number }>();
  const layerLayouts: LayerLayoutInfo[] = [];

  for (const child of result.children || []) {
    const childX = child.x || 0;
    const childY = child.y || 0;
    const layer = layers.find((l) => l.id === child.id);

    if (layer) {
      layerLayouts.push({
        layerId: layer.id,
        layerName: layer.name,
        color: layer.color,
        x: childX,
        y: childY,
        width: child.width || 320,
        height: child.height || 200,
      });

      // Children coords from ELK are relative to the layer node
      for (const nested of child.children || []) {
        absolutePositions.set(nested.id, {
          x: childX + (nested.x || 0),
          y: childY + (nested.y || 0),
        });
      }
    } else {
      absolutePositions.set(child.id, { x: childX, y: childY });
    }
  }

  const edgeBendPoints = new Map<string, { x: number; y: number }[][]>();
  for (const edge of result.edges || []) {
    if (edge.sections) {
      const points: { x: number; y: number }[][] = [];
      for (const section of edge.sections) {
        const sectionPoints: { x: number; y: number }[] = [];
        sectionPoints.push(section.startPoint);
        if (section.bendPoints) {
          sectionPoints.push(...section.bendPoints);
        }
        sectionPoints.push(section.endPoint);
        points.push(sectionPoints);
      }
      edgeBendPoints.set(edge.id, points);
    }
  }

  const newNodes = originalNodes.map((node) => {
    const position = absolutePositions.get(node.id);
    return {
      ...node,
      position: position || node.position,
    };
  });

  const newEdges = originalEdges.map((edge) => {
    const sections = edgeBendPoints.get(edge.id);
    let waypoints: Point[] | undefined = sections?.length ? sections.flatMap((section, index) => (index === 0 ? section : section.slice(1))) : undefined;

    if (waypoints?.length) {
      const srcLayer = layers.find((l) => l.tableNames.includes(edge.source));
      const tgtLayer = layers.find((l) => l.tableNames.includes(edge.target));
      // Same-layer edges: ELK section coords are relative to the layer compound node
      if (srcLayer && tgtLayer && srcLayer.id === tgtLayer.id) {
        const layout = layerLayouts.find((l) => l.layerId === srcLayer.id);
        if (layout) {
          waypoints = waypoints.map((p) => ({ x: p.x + layout.x, y: p.y + layout.y }));
        }
      }
    }

    const handles = waypoints ? handlesFromWaypoints(waypoints) : null;
    return {
      ...edge,
      waypoints,
      sourceHandle: handles?.sourceHandle,
      targetHandle: handles?.targetHandle,
    };
  });

  return {
    nodes: newNodes,
    edges: newEdges,
    layerLayouts,
  };
}
