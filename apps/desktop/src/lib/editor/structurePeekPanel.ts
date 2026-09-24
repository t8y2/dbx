/** Identity + geometry helpers for in-app table-structure peek panels. */

export function structurePeekPanelId(connectionId: string, database: string, schema: string | undefined, tableName: string, catalog?: string): string {
  return [connectionId, catalog ?? "", database, schema ?? "", tableName].map((part) => part.toLocaleLowerCase()).join("\u0000");
}

export const STRUCTURE_PEEK_MARGIN = 8;
export const STRUCTURE_PEEK_MIN_WIDTH = 360;
export const STRUCTURE_PEEK_MIN_HEIGHT = 240;
export const STRUCTURE_PEEK_CASCADE = 24;

export function defaultStructurePeekSize(viewportWidth: number, viewportHeight: number): { width: number; height: number } {
  const maxWidth = Math.max(STRUCTURE_PEEK_MIN_WIDTH, viewportWidth - STRUCTURE_PEEK_MARGIN * 2);
  const maxHeight = Math.max(STRUCTURE_PEEK_MIN_HEIGHT, viewportHeight - STRUCTURE_PEEK_MARGIN * 2);
  // Default large enough to scan columns comfortably without covering most of the editor.
  return {
    width: Math.min(720, Math.floor(viewportWidth * 0.62), maxWidth),
    height: Math.min(520, Math.floor(viewportHeight * 0.62), maxHeight),
  };
}

export function centeredStructurePeekRect(width: number, height: number, viewportWidth: number, viewportHeight: number, cascadeIndex = 0): StructurePeekRect {
  const stagger = cascadeIndex * STRUCTURE_PEEK_CASCADE;
  return clampStructurePeekRect(
    {
      left: Math.round((viewportWidth - width) / 2) + stagger,
      top: Math.round((viewportHeight - height) / 2) + stagger,
      width,
      height,
    },
    viewportWidth,
    viewportHeight,
  );
}

export interface StructurePeekRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Keep the panel fully inside the viewport (with margin), respecting min size. */
export function clampStructurePeekRect(rect: StructurePeekRect, viewportWidth: number, viewportHeight: number, margin = STRUCTURE_PEEK_MARGIN, minWidth = STRUCTURE_PEEK_MIN_WIDTH, minHeight = STRUCTURE_PEEK_MIN_HEIGHT): StructurePeekRect {
  const maxWidth = Math.max(minWidth, viewportWidth - margin * 2);
  const maxHeight = Math.max(minHeight, viewportHeight - margin * 2);
  const width = Math.min(Math.max(rect.width, minWidth), maxWidth);
  const height = Math.min(Math.max(rect.height, minHeight), maxHeight);
  const maxLeft = Math.max(margin, viewportWidth - margin - width);
  const maxTop = Math.max(margin, viewportHeight - margin - height);
  const left = Math.min(Math.max(rect.left, margin), maxLeft);
  const top = Math.min(Math.max(rect.top, margin), maxTop);
  return { left, top, width, height };
}

export type StructurePeekResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RESIZE_EAST: ReadonlySet<StructurePeekResizeEdge> = new Set(["e", "ne", "se"]);
const RESIZE_WEST: ReadonlySet<StructurePeekResizeEdge> = new Set(["w", "nw", "sw"]);
const RESIZE_NORTH: ReadonlySet<StructurePeekResizeEdge> = new Set(["n", "ne", "nw"]);
const RESIZE_SOUTH: ReadonlySet<StructurePeekResizeEdge> = new Set(["s", "se", "sw"]);

export function resizeStructurePeekRect(origin: StructurePeekRect, edge: StructurePeekResizeEdge, deltaX: number, deltaY: number, viewportWidth: number, viewportHeight: number): StructurePeekRect {
  let { left, top, width, height } = origin;

  if (RESIZE_EAST.has(edge)) width = origin.width + deltaX;
  if (RESIZE_SOUTH.has(edge)) height = origin.height + deltaY;
  if (RESIZE_WEST.has(edge)) {
    width = origin.width - deltaX;
    left = origin.left + deltaX;
  }
  if (RESIZE_NORTH.has(edge)) {
    height = origin.height - deltaY;
    top = origin.top + deltaY;
  }

  // When shrinking past min from the west/north edge, pin the opposite side.
  if (RESIZE_WEST.has(edge) && width < STRUCTURE_PEEK_MIN_WIDTH) {
    left = origin.left + origin.width - STRUCTURE_PEEK_MIN_WIDTH;
    width = STRUCTURE_PEEK_MIN_WIDTH;
  }
  if (RESIZE_NORTH.has(edge) && height < STRUCTURE_PEEK_MIN_HEIGHT) {
    top = origin.top + origin.height - STRUCTURE_PEEK_MIN_HEIGHT;
    height = STRUCTURE_PEEK_MIN_HEIGHT;
  }

  return clampStructurePeekRect({ left, top, width, height }, viewportWidth, viewportHeight);
}
