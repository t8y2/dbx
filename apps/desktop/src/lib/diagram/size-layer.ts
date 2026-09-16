import type { DiagramLayer } from "@/types/diagram";
import { CARD_WIDTH, EMPTY_LAYER_HEIGHT, EMPTY_LAYER_WIDTH, LAYER_CONTENT_PADDING, LAYER_HEADER_HEIGHT, MARGIN } from "./diagram-constants";

type Rect = { x: number; y: number; width: number; height: number };

function rectsOverlap(a: Rect, b: Rect, gap = 8): boolean {
  return !(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y);
}

function collectOccupiedRects(layers: DiagramLayer[], tablePositions: Record<string, { x: number; y: number }>, tableHeights: Record<string, number>, excludeLayerId?: string): Rect[] {
  const rects: Rect[] = [];

  for (const [name, position] of Object.entries(tablePositions)) {
    const parented = layers.some((l) => l.id !== excludeLayerId && l.tableNames.includes(name));
    // Tables inside a layer are covered by the layer rect; still include unassigned tables
    if (parented) continue;
    rects.push({
      x: position.x,
      y: position.y,
      width: CARD_WIDTH,
      height: tableHeights[name] ?? 120,
    });
  }

  for (const layer of layers) {
    if (excludeLayerId && layer.id === excludeLayerId) continue;
    if (!layer.visible || layer.position == null || layer.width == null || layer.height == null) continue;
    rects.push({
      x: layer.position.x,
      y: layer.position.y,
      width: layer.width,
      height: layer.height,
    });
  }

  return rects;
}

export function sizeLayerToFit(layer: DiagramLayer, tablePositions: Record<string, { x: number; y: number }>, tableHeights: Record<string, number>): void {
  if (layer.tableNames.length === 0) {
    layer.width = EMPTY_LAYER_WIDTH;
    layer.height = EMPTY_LAYER_HEIGHT;
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const name of layer.tableNames) {
    const position = tablePositions[name];
    if (!position) continue;
    const height = tableHeights[name] ?? 120;
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + CARD_WIDTH);
    maxY = Math.max(maxY, position.y + height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    layer.width = EMPTY_LAYER_WIDTH;
    layer.height = EMPTY_LAYER_HEIGHT;
    return;
  }

  layer.position = {
    x: minX - LAYER_CONTENT_PADDING,
    y: minY - LAYER_HEADER_HEIGHT - LAYER_CONTENT_PADDING,
  };
  layer.width = Math.max(EMPTY_LAYER_WIDTH, maxX - minX + LAYER_CONTENT_PADDING * 2);
  layer.height = Math.max(EMPTY_LAYER_HEIGHT, maxY - minY + LAYER_HEADER_HEIGHT + LAYER_CONTENT_PADDING * 2);
}

export function pointInLayerBounds(point: { x: number; y: number }, layer: DiagramLayer): boolean {
  if (!layer.visible || layer.position == null || layer.width == null || layer.height == null) {
    return false;
  }
  const { x, y } = layer.position;
  return point.x >= x && point.x <= x + layer.width && point.y >= y && point.y <= y + layer.height;
}

export function findLayerAtPoint(point: { x: number; y: number }, layers: DiagramLayer[], excludeLayerId?: string): DiagramLayer | undefined {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (excludeLayerId && layer.id === excludeLayerId) continue;
    if (pointInLayerBounds(point, layer)) return layer;
  }
  return undefined;
}

/**
 * Place a new empty layer near the top-left of the canvas without overlapping
 * existing tables or layers.
 */
export function placeNewLayer(layers: DiagramLayer[], tablePositions: Record<string, { x: number; y: number }>, tableHeights: Record<string, number>, options?: { width?: number; height?: number; startY?: number }): { position: { x: number; y: number }; width: number; height: number } {
  const width = options?.width ?? EMPTY_LAYER_WIDTH;
  const height = options?.height ?? EMPTY_LAYER_HEIGHT;
  const startY = options?.startY ?? MARGIN;
  const occupied = collectOccupiedRects(layers, tablePositions, tableHeights);
  const stepX = width + 16;
  const stepY = height + 16;
  const maxX = 2400;

  for (let row = 0; row < 40; row += 1) {
    const y = startY + row * stepY;
    for (let x = MARGIN; x + width <= maxX; x += stepX) {
      const candidate: Rect = { x, y, width, height };
      if (!occupied.some((rect) => rectsOverlap(candidate, rect))) {
        return { position: { x, y }, width, height };
      }
    }
  }

  return { position: { x: MARGIN, y: startY + occupied.length * stepY }, width, height };
}
