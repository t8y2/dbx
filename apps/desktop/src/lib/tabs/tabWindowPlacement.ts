export const DETACHED_TAB_WINDOW_WIDTH = 1200;
export const DETACHED_TAB_WINDOW_HEIGHT = 800;

const PREVIEW_MARGIN = 12;
const PREVIEW_GRAB_X = 120;
const PREVIEW_GRAB_Y = 18;

export interface TabWindowClientPlacement {
  left: number;
  top: number;
}

export interface TabWindowPreviewRect extends TabWindowClientPlacement {
  width: number;
  height: number;
  scale: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface RectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function pointOutsideRect(point: Point, rect: RectBounds, margin = 0): boolean {
  return point.x < rect.left - margin || point.x > rect.right + margin || point.y < rect.top - margin || point.y > rect.bottom + margin;
}

export function detachedTabWindowPreviewRect(point: Point, viewport: Size): TabWindowPreviewRect {
  const availableWidth = Math.max(1, viewport.width - PREVIEW_MARGIN * 2);
  const availableHeight = Math.max(1, viewport.height - PREVIEW_MARGIN * 2);
  const scale = Math.min(1, availableWidth / DETACHED_TAB_WINDOW_WIDTH, availableHeight / DETACHED_TAB_WINDOW_HEIGHT);
  const width = DETACHED_TAB_WINDOW_WIDTH * scale;
  const height = DETACHED_TAB_WINDOW_HEIGHT * scale;
  const left = clamp(point.x - PREVIEW_GRAB_X * scale, PREVIEW_MARGIN, viewport.width - width - PREVIEW_MARGIN);
  const top = clamp(point.y - PREVIEW_GRAB_Y * scale, PREVIEW_MARGIN, viewport.height - height - PREVIEW_MARGIN);
  return { left, top, width, height, scale };
}

export function detachedTabWindowLogicalPosition(sourceInnerPhysical: Point, sourceScaleFactor: number, sourceDevicePixelRatio: number, placement: TabWindowClientPlacement): Point {
  const scaleFactor = sourceScaleFactor > 0 ? sourceScaleFactor : 1;
  const devicePixelRatio = sourceDevicePixelRatio > 0 ? sourceDevicePixelRatio : scaleFactor;
  return {
    x: (sourceInnerPhysical.x + placement.left * devicePixelRatio) / scaleFactor,
    y: (sourceInnerPhysical.y + placement.top * devicePixelRatio) / scaleFactor,
  };
}
