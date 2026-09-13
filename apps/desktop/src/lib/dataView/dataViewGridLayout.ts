import type { DataViewGridPos } from "@/types/dataView";

/** Dashboard-grid constants, matching Grafana's real defaults. */
export const GRID_COLUMNS = 12;
export const ROW_UNIT_PX = 30;
export const GRID_MARGIN_PX = 8;
export const MIN_PANEL_W = 3;
export const MIN_PANEL_H = 4;
/** Row-unit height used for the auto-stacked default layout. */
const DEFAULT_PANEL_H = 8;

/** Axis-aligned bounding-box overlap test in grid units. */
export function collides(a: DataViewGridPos, b: DataViewGridPos): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Full-width panel stacked below earlier panels, used until the user first edits the layout. */
export function defaultGridPos(orderIndex: number): DataViewGridPos {
  return { x: 0, y: orderIndex * DEFAULT_PANEL_H, w: GRID_COLUMNS, h: DEFAULT_PANEL_H };
}

/** Clamp a candidate rect to valid grid bounds (non-negative position, size within column/row minimums). */
export function clampGridPos(gridPos: DataViewGridPos): DataViewGridPos {
  const w = Math.min(GRID_COLUMNS, Math.max(MIN_PANEL_W, gridPos.w));
  const h = Math.max(MIN_PANEL_H, gridPos.h);
  const x = Math.min(GRID_COLUMNS - w, Math.max(0, gridPos.x));
  const y = Math.max(0, gridPos.y);
  return { x, y, w, h };
}

/** Lowest y at or above the candidate's own y that doesn't collide with any placed rect. */
function findFreeY(gridPos: DataViewGridPos, placed: DataViewGridPos[]): number {
  let y = gridPos.y;
  let moved = true;
  while (moved) {
    moved = false;
    for (const rect of placed) {
      if (collides(rect, { ...gridPos, y })) {
        y = rect.y + rect.h;
        moved = true;
      }
    }
  }
  return y;
}

/**
 * Vertical compaction: sort by (y, x) then place each entry at the lowest y
 * that doesn't collide with anything already placed (react-grid-layout's
 * compact-vertical algorithm). `obstacles` are extra fixed rects (e.g. the
 * panel currently being dragged) that participate in collisions but are
 * never themselves moved or included in the result.
 */
export function compactLayout(entries: { id: string; gridPos: DataViewGridPos }[], obstacles: DataViewGridPos[] = []): Map<string, DataViewGridPos> {
  const sorted = [...entries].sort((a, b) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x);
  const placed: DataViewGridPos[] = [...obstacles];
  const result = new Map<string, DataViewGridPos>();
  for (const entry of sorted) {
    const candidate: DataViewGridPos = { ...entry.gridPos, y: findFreeY({ ...entry.gridPos, y: 0 }, placed) };
    placed.push(candidate);
    result.set(entry.id, candidate);
  }
  return result;
}

/** Merges each query's persisted `gridPos` with a stacked default for queries that don't have one yet, then compacts to resolve any overlap. */
export function resolveGridLayout(queries: { id: string; gridPos?: DataViewGridPos | null }[]): Map<string, DataViewGridPos> {
  const entries = queries.map((query, index) => ({ id: query.id, gridPos: query.gridPos ?? defaultGridPos(index) }));
  return compactLayout(entries);
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Pixel width of a single grid column given the container's content width. */
export function columnWidthPx(containerWidthPx: number): number {
  return (containerWidthPx - (GRID_COLUMNS - 1) * GRID_MARGIN_PX) / GRID_COLUMNS;
}

export function gridRectToPixels(gridPos: DataViewGridPos, colWidthPx: number): PixelRect {
  return {
    left: gridPos.x * (colWidthPx + GRID_MARGIN_PX),
    top: gridPos.y * (ROW_UNIT_PX + GRID_MARGIN_PX),
    width: gridPos.w * colWidthPx + (gridPos.w - 1) * GRID_MARGIN_PX,
    height: gridPos.h * (ROW_UNIT_PX + GRID_MARGIN_PX) - GRID_MARGIN_PX,
  };
}

/** Rounds a pixel delta to the nearest whole grid unit for drag/resize snapping. */
export function pixelDeltaToGridUnits(dxPx: number, dyPx: number, colWidthPx: number): { dx: number; dy: number } {
  return {
    dx: Math.round(dxPx / (colWidthPx + GRID_MARGIN_PX)),
    dy: Math.round(dyPx / (ROW_UNIT_PX + GRID_MARGIN_PX)),
  };
}

/** Total grid-container height in px needed to fit every panel. */
export function gridContainerHeightPx(gridPositions: DataViewGridPos[]): number {
  const maxY = gridPositions.reduce((max, pos) => Math.max(max, pos.y + pos.h), 0);
  return maxY * (ROW_UNIT_PX + GRID_MARGIN_PX);
}
