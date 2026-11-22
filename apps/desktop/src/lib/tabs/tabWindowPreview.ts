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

export function tabWindowBoundsInWorkArea(
  position: { x: number; y: number } | undefined,
  monitor: {
    scaleFactor: number;
    position: { x: number; y: number };
    size: { width: number; height: number };
    workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
  },
): { x: number; y: number; width: number; height: number; minWidth: number; minHeight: number } {
  const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  const area = monitor.workArea ?? monitor;
  const left = area.position.x / scale + PREVIEW_MARGIN;
  const top = area.position.y / scale + PREVIEW_MARGIN;
  const availableWidth = Math.max(1, area.size.width / scale - PREVIEW_MARGIN * 2);
  const availableHeight = Math.max(1, area.size.height / scale - PREVIEW_MARGIN * 2);
  const width = Math.min(TAB_WINDOW_PREVIEW_WIDTH, availableWidth);
  const height = Math.min(TAB_WINDOW_PREVIEW_HEIGHT, availableHeight);
  return {
    x: clamp(position?.x ?? left + (availableWidth - width) / 2, left, left + availableWidth - width),
    y: clamp(position?.y ?? top + (availableHeight - height) / 2, top, top + availableHeight - height),
    width,
    height,
    minWidth: Math.min(900, width),
    minHeight: Math.min(600, height),
  };
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
