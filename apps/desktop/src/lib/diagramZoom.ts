export const DIAGRAM_MIN_ZOOM = 0.6;
export const DIAGRAM_MAX_ZOOM = 1.5;
const WHEEL_ZOOM_SENSITIVITY = 0.003;

export function clampDiagramZoom(value: number): number {
  const clamped = Math.min(DIAGRAM_MAX_ZOOM, Math.max(DIAGRAM_MIN_ZOOM, value));
  return Number(clamped.toFixed(2));
}

export function zoomFromWheelDelta(currentZoom: number, deltaY: number): number {
  return clampDiagramZoom(currentZoom * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY));
}

export function zoomFromGestureScale(startZoom: number, scale: number): number {
  return clampDiagramZoom(startZoom * scale);
}
