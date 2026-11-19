export const DIAGRAM_MIN_ZOOM = 0.05;
export const DIAGRAM_MAX_ZOOM = 2;
const WHEEL_ZOOM_SENSITIVITY = 0.003;

export function clampDiagramZoom(value: number): number {
  // Trackpads emit fractional deltas. Rounding each event discards slow pinches entirely.
  return Math.min(DIAGRAM_MAX_ZOOM, Math.max(DIAGRAM_MIN_ZOOM, value));
}

export function zoomFromWheelDelta(currentZoom: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return currentZoom;
  return clampDiagramZoom(currentZoom * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY));
}

/** Wheel deltas may be expressed in pixels, lines, or pages. */
export function normalizeDiagramWheelDelta(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  return deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
}

/** Keep the world point beneath the cursor fixed while changing zoom. */
export function diagramViewportAtZoom(viewport: { x: number; y: number; zoom: number }, pointer: { x: number; y: number }, zoom: number) {
  const nextZoom = clampDiagramZoom(zoom);
  const scale = nextZoom / viewport.zoom;
  return { x: pointer.x - (pointer.x - viewport.x) * scale, y: pointer.y - (pointer.y - viewport.y) * scale, zoom: nextZoom };
}

export function zoomFromGestureScale(startZoom: number, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return startZoom;
  return clampDiagramZoom(startZoom * scale);
}
