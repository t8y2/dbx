import type { DiagramLayer } from "@/types/diagram";
import type { DiagramPosition, DiagramTable } from "@/lib/diagram/erDiagram";
import { layoutDiagramTables } from "@/lib/diagram/erDiagram";
import { sizeLayerToFit } from "@/lib/diagram/size-layer";
import { CARD_WIDTH, EMPTY_LAYER_HEIGHT, EMPTY_LAYER_WIDTH, GAP_X, GAP_Y, LAYER_CONTENT_PADDING, LAYER_HEADER_HEIGHT, MARGIN, columnsPerRowForWidth, tableCardHeight } from "@/lib/diagram/diagram-constants";

export interface LtrAutoLayoutInput {
  tables: DiagramTable[];
  positions: Record<string, DiagramPosition>;
  layers: DiagramLayer[];
  paneWidth: number;
  /** Optional edges used to cluster related tables in LTR order. */
  relationships?: Array<{ sourceTable: string; targetTable: string }>;
}

export interface LtrAutoLayoutResult {
  positions: Record<string, DiagramPosition>;
  /** Mutated copies of visible layers with updated geometry (caller should apply to store). */
  layers: DiagramLayer[];
}

type LayerBox = {
  layer: DiagramLayer;
  width: number;
  height: number;
  /** Absolute table positions relative to a provisional origin (0,0) for the layer box. */
  localTablePositions: Record<string, DiagramPosition>;
};

function tableHeightsMap(tables: DiagramTable[]): Record<string, number> {
  const heights: Record<string, number> = {};
  for (const table of tables) {
    heights[table.name] = tableCardHeight(table.columns?.length ?? 0);
  }
  return heights;
}

/** Order tables so connected components stay adjacent (for friendlier LTR grids). */
export function orderTablesByConnectivity(tables: DiagramTable[], relationships: Array<{ sourceTable: string; targetTable: string }> = []): DiagramTable[] {
  if (tables.length <= 1 || relationships.length === 0) return [...tables];

  const nameSet = new Set(tables.map((t) => t.name));
  const adj = new Map<string, Set<string>>();
  for (const name of nameSet) adj.set(name, new Set());

  for (const rel of relationships) {
    if (!nameSet.has(rel.sourceTable) || !nameSet.has(rel.targetTable)) continue;
    if (rel.sourceTable === rel.targetTable) continue;
    adj.get(rel.sourceTable)!.add(rel.targetTable);
    adj.get(rel.targetTable)!.add(rel.sourceTable);
  }

  const byName = new Map(tables.map((t) => [t.name, t]));
  const visited = new Set<string>();
  const ordered: DiagramTable[] = [];

  const visitComponent = (start: string) => {
    const stack = [start];
    const component: string[] = [];
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);
      component.push(name);
      for (const next of adj.get(name) ?? []) {
        if (!visited.has(next)) stack.push(next);
      }
    }
    component.sort((a, b) => a.localeCompare(b));
    for (const name of component) {
      const table = byName.get(name);
      if (table) ordered.push(table);
    }
  };

  // Prefer starting from tables that have edges, then isolates (stable name order)
  const withEdges = tables.filter((t) => (adj.get(t.name)?.size ?? 0) > 0).sort((a, b) => a.name.localeCompare(b.name));
  const isolates = tables.filter((t) => (adj.get(t.name)?.size ?? 0) === 0).sort((a, b) => a.name.localeCompare(b.name));

  for (const table of withEdges) {
    if (!visited.has(table.name)) visitComponent(table.name);
  }
  for (const table of isolates) {
    if (!visited.has(table.name)) ordered.push(table);
  }

  return ordered;
}

/**
 * Reflow unassigned (not in any visible layer) tables into an LTR grid,
 * preserving approximate visual order (sort by y then x).
 */
export function reflowUnassignedTables(input: { tables: DiagramTable[]; positions: Record<string, DiagramPosition>; layers: DiagramLayer[]; paneWidth: number; yOrigin?: number }): Record<string, DiagramPosition> {
  const { tables, positions, layers, paneWidth } = input;
  const columnsPerRow = columnsPerRowForWidth(paneWidth);
  const assigned = new Set(layers.filter((l) => l.visible).flatMap((l) => l.tableNames));
  const unassigned = tables.filter((t) => !assigned.has(t.name));
  if (unassigned.length === 0) return { ...positions };

  const sorted = [...unassigned].sort((a, b) => {
    const pa = positions[a.name] ?? { x: 0, y: 0 };
    const pb = positions[b.name] ?? { x: 0, y: 0 };
    if (pa.y !== pb.y) return pa.y - pb.y;
    return pa.x - pb.x;
  });

  let layersBottom = MARGIN;
  for (const layer of layers.filter((l) => l.visible)) {
    if (layer.position == null || layer.height == null) continue;
    layersBottom = Math.max(layersBottom, layer.position.y + layer.height);
  }

  const yOrigin = input.yOrigin ?? (layers.some((l) => l.visible) ? layersBottom + GAP_Y : MARGIN);
  const grid = layoutDiagramTables(sorted, {
    columnsPerRow,
    cardWidth: CARD_WIDTH,
    gapX: GAP_X,
    gapY: GAP_Y,
    margin: MARGIN,
  });

  const next = { ...positions };
  const yOffset = yOrigin - MARGIN;
  for (const [name, pos] of Object.entries(grid)) {
    next[name] = { x: pos.x, y: pos.y + yOffset };
  }
  return next;
}

function measureFreeLocal(layer: DiagramLayer, positions: Record<string, DiagramPosition>, heights: Record<string, number>): LayerBox {
  if (layer.tableNames.length === 0) {
    return {
      layer,
      width: EMPTY_LAYER_WIDTH,
      height: EMPTY_LAYER_HEIGHT,
      localTablePositions: {},
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const absolute: Record<string, DiagramPosition> = {};

  for (const name of layer.tableNames) {
    const position = positions[name];
    if (!position) continue;
    const height = heights[name] ?? 120;
    absolute[name] = { ...position };
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + CARD_WIDTH);
    maxY = Math.max(maxY, position.y + height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      layer,
      width: EMPTY_LAYER_WIDTH,
      height: EMPTY_LAYER_HEIGHT,
      localTablePositions: {},
    };
  }

  const originX = minX - LAYER_CONTENT_PADDING;
  const originY = minY - LAYER_HEADER_HEIGHT - LAYER_CONTENT_PADDING;
  const localTablePositions: Record<string, DiagramPosition> = {};
  for (const [name, pos] of Object.entries(absolute)) {
    localTablePositions[name] = { x: pos.x - originX, y: pos.y - originY };
  }

  return {
    layer,
    width: Math.max(EMPTY_LAYER_WIDTH, maxX - minX + LAYER_CONTENT_PADDING * 2),
    height: Math.max(EMPTY_LAYER_HEIGHT, maxY - minY + LAYER_HEADER_HEIGHT + LAYER_CONTENT_PADDING * 2),
    localTablePositions,
  };
}

function measureAutoLocal(layer: DiagramLayer, tablesByName: Map<string, DiagramTable>, columnsPerRow: number): LayerBox {
  if (layer.tableNames.length === 0) {
    return {
      layer,
      width: EMPTY_LAYER_WIDTH,
      height: EMPTY_LAYER_HEIGHT,
      localTablePositions: {},
    };
  }

  const layerTables = layer.tableNames.map((name) => tablesByName.get(name)).filter((t): t is DiagramTable => !!t);

  if (layerTables.length === 0) {
    return {
      layer,
      width: EMPTY_LAYER_WIDTH,
      height: EMPTY_LAYER_HEIGHT,
      localTablePositions: {},
    };
  }

  // Layout with margin 0, then offset into layer content area
  const grid = layoutDiagramTables(layerTables, {
    columnsPerRow,
    cardWidth: CARD_WIDTH,
    gapX: GAP_X,
    gapY: GAP_Y,
    margin: 0,
  });

  const localTablePositions: Record<string, DiagramPosition> = {};
  for (const [name, pos] of Object.entries(grid)) {
    localTablePositions[name] = {
      x: pos.x + LAYER_CONTENT_PADDING,
      y: pos.y + LAYER_HEADER_HEIGHT + LAYER_CONTENT_PADDING,
    };
  }

  // Provisional size via sizeLayerToFit against local coords (origin 0,0)
  const scratch: DiagramLayer = {
    ...layer,
    position: { x: 0, y: 0 },
    tableNames: [...layer.tableNames],
  };
  const heights = tableHeightsMap(layerTables);
  sizeLayerToFit(scratch, localTablePositions, heights);

  return {
    layer,
    width: scratch.width ?? EMPTY_LAYER_WIDTH,
    height: scratch.height ?? EMPTY_LAYER_HEIGHT,
    localTablePositions,
  };
}

/**
 * Auto-layout: visible layers packed at top (LTR wrap), unassigned tables
 * in an LTR grid below — same column logic as initial resetLayout.
 */
export function computeLtrAutoLayout(input: LtrAutoLayoutInput): LtrAutoLayoutResult {
  const { tables, positions: prevPositions, layers, paneWidth, relationships = [] } = input;
  const columnsPerRow = columnsPerRowForWidth(paneWidth);
  const heights = tableHeightsMap(tables);
  const tablesByName = new Map(tables.map((t) => [t.name, t]));
  const nextPositions: Record<string, DiagramPosition> = { ...prevPositions };

  const visibleLayers = layers.filter((l) => l.visible);
  const assigned = new Set(visibleLayers.flatMap((l) => l.tableNames));
  const orderedTables = orderTablesByConnectivity(tables, relationships);
  const unassigned = orderedTables.filter((t) => !assigned.has(t.name));

  if (visibleLayers.length === 0) {
    const grid = layoutDiagramTables(orderedTables, {
      columnsPerRow,
      cardWidth: CARD_WIDTH,
      gapX: GAP_X,
      gapY: GAP_Y,
      margin: MARGIN,
    });
    return { positions: { ...nextPositions, ...grid }, layers: [] };
  }

  const boxes: LayerBox[] = visibleLayers.map((layer) => {
    const mode = layer.layoutMode ?? "free";
    if (mode === "auto") {
      const layerTables = orderTablesByConnectivity(
        layer.tableNames.map((n) => tablesByName.get(n)).filter((t): t is DiagramTable => !!t),
        relationships,
      );
      const scratchLayer = { ...layer, tableNames: layerTables.map((t) => t.name) };
      return measureAutoLocal(scratchLayer, tablesByName, columnsPerRow);
    }
    return measureFreeLocal(layer, prevPositions, heights);
  });

  const usableWidth = Math.max(CARD_WIDTH, paneWidth - MARGIN * 2);
  let cursorX = MARGIN;
  let cursorY = MARGIN;
  let rowHeight = 0;
  let layersBottom = MARGIN;

  const updatedLayers: DiagramLayer[] = [];

  for (const box of boxes) {
    const { width, height, localTablePositions, layer } = box;

    if (cursorX > MARGIN && cursorX + width > MARGIN + usableWidth) {
      cursorX = MARGIN;
      cursorY += rowHeight + GAP_Y;
      rowHeight = 0;
    }

    const placed: DiagramLayer = {
      ...layer,
      position: { x: cursorX, y: cursorY },
      width,
      height,
      tableNames: [...layer.tableNames],
    };

    for (const [name, local] of Object.entries(localTablePositions)) {
      nextPositions[name] = {
        x: cursorX + local.x,
        y: cursorY + local.y,
      };
    }

    // Reconcile size from absolute table positions (auto / free with tables)
    if (placed.tableNames.length > 0) {
      sizeLayerToFit(placed, nextPositions, heights);
    } else {
      placed.width = EMPTY_LAYER_WIDTH;
      placed.height = EMPTY_LAYER_HEIGHT;
      placed.position = { x: cursorX, y: cursorY };
    }

    const finalW = placed.width ?? width;
    const finalH = placed.height ?? height;
    const finalX = placed.position?.x ?? cursorX;
    const finalY = placed.position?.y ?? cursorY;

    updatedLayers.push(placed);

    cursorX = finalX + finalW + GAP_X;
    rowHeight = Math.max(rowHeight, finalH);
    layersBottom = Math.max(layersBottom, finalY + finalH);
  }

  if (unassigned.length > 0) {
    const grid = layoutDiagramTables(unassigned, {
      columnsPerRow,
      cardWidth: CARD_WIDTH,
      gapX: GAP_X,
      gapY: GAP_Y,
      margin: MARGIN,
    });
    const yOffset = layersBottom + GAP_Y - MARGIN;
    for (const [name, pos] of Object.entries(grid)) {
      nextPositions[name] = { x: pos.x, y: pos.y + yOffset };
    }
  }

  return { positions: nextPositions, layers: updatedLayers };
}
