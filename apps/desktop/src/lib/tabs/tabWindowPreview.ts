export const TAB_WINDOW_PREVIEW_WIDTH = 1200;
export const TAB_WINDOW_PREVIEW_HEIGHT = 800;
export const TAB_DRAG_PREVIEW_WIDTH = 300;
export const TAB_DRAG_PREVIEW_HEIGHT = 34;
export const TAB_DRAG_PREVIEW_GRAB_X = 18;
export const TAB_DRAG_PREVIEW_GRAB_Y = 17;
export const TAB_DRAG_PREVIEW_HOST_PADDING = 8;

const PREVIEW_MARGIN = 12;
const PREVIEW_GRAB_X = 120;
const PREVIEW_GRAB_Y = 18;

export interface TabWindowPreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function pointOutsideRect(point: { x: number; y: number }, rect: { left: number; top: number; right: number; bottom: number }, margin = 0): boolean {
  return point.x < rect.left - margin || point.x > rect.right + margin || point.y < rect.top - margin || point.y > rect.bottom + margin;
}

/** Builds an in-window outline before a drag becomes a real native window. */
export function tabWindowPreviewRect(point: { x: number; y: number }, viewport: { width: number; height: number }): TabWindowPreviewRect {
  const availableWidth = Math.max(1, viewport.width - PREVIEW_MARGIN * 2);
  const availableHeight = Math.max(1, viewport.height - PREVIEW_MARGIN * 2);
  const scale = Math.min(1, availableWidth / TAB_WINDOW_PREVIEW_WIDTH, availableHeight / TAB_WINDOW_PREVIEW_HEIGHT);
  const width = TAB_WINDOW_PREVIEW_WIDTH * scale;
  const height = TAB_WINDOW_PREVIEW_HEIGHT * scale;
  return {
    width,
    height,
    left: clamp(point.x - PREVIEW_GRAB_X * scale, PREVIEW_MARGIN, viewport.width - width - PREVIEW_MARGIN),
    top: clamp(point.y - PREVIEW_GRAB_Y * scale, PREVIEW_MARGIN, viewport.height - height - PREVIEW_MARGIN),
  };
}

/** A compact tab chip used while dragging across native windows or outside DBX. */
export function tabDragPreviewRect(point: { x: number; y: number }, viewport: { width: number; height: number }): TabWindowPreviewRect {
  const width = Math.min(TAB_DRAG_PREVIEW_WIDTH, Math.max(1, viewport.width - PREVIEW_MARGIN * 2));
  const height = Math.min(TAB_DRAG_PREVIEW_HEIGHT, Math.max(1, viewport.height - PREVIEW_MARGIN * 2));
  return {
    width,
    height,
    left: clamp(point.x - TAB_DRAG_PREVIEW_GRAB_X, PREVIEW_MARGIN, viewport.width - width - PREVIEW_MARGIN),
    top: clamp(point.y - TAB_DRAG_PREVIEW_GRAB_Y, PREVIEW_MARGIN, viewport.height - height - PREVIEW_MARGIN),
  };
}
