export interface DataGridWheelMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

export interface DataGridWheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  lineSize: number;
  metrics: DataGridWheelMetrics;
  accelerationFactor?: number;
}

export interface DataGridWheelScroll {
  scrollDeltaX: number;
  scrollDeltaY: number;
  nextScrollTop: number;
  nextScrollLeft: number;
  moved: boolean;
}

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

function wheelDeltaToPixels(delta: number, deltaMode: number, lineSize: number, pageSize: number): number {
  if (deltaMode === DOM_DELTA_LINE) return delta * lineSize;
  if (deltaMode === DOM_DELTA_PAGE) return delta * pageSize;
  return delta;
}

export function resolveDataGridWheelScroll(input: DataGridWheelInput): DataGridWheelScroll {
  const { metrics } = input;
  if (input.ctrlKey || input.metaKey) {
    return {
      scrollDeltaX: 0,
      scrollDeltaY: 0,
      nextScrollTop: metrics.scrollTop,
      nextScrollLeft: metrics.scrollLeft,
      moved: false,
    };
  }

  const accelerationFactor = input.accelerationFactor ?? 1;
  const normalizedDeltaX = wheelDeltaToPixels(input.deltaX, input.deltaMode, input.lineSize, metrics.clientWidth);
  const normalizedDeltaY = wheelDeltaToPixels(input.deltaY, input.deltaMode, input.lineSize, metrics.clientHeight);
  const shiftedDeltaY = input.shiftKey && Math.abs(normalizedDeltaY) > Math.abs(normalizedDeltaX) ? normalizedDeltaY : 0;
  // Native pixel deltas are already expressed in CSS pixels. When a device reports deltaX,
  // preserve both axes at 1:1 so diagonal trackpad input is not distorted by Canvas acceleration.
  const hasNativePixelDeltaX = input.deltaMode === DOM_DELTA_PIXEL && input.deltaX !== 0;
  const horizontalAcceleration = hasNativePixelDeltaX ? 1 : accelerationFactor;
  const verticalAcceleration = hasNativePixelDeltaX ? 1 : accelerationFactor;
  const scrollDeltaX = normalizedDeltaX * horizontalAcceleration + shiftedDeltaY * accelerationFactor;
  const scrollDeltaY = shiftedDeltaY === 0 ? normalizedDeltaY * verticalAcceleration : 0;
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  const nextScrollTop = Math.max(0, Math.min(maxScrollTop, metrics.scrollTop + scrollDeltaY));
  const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, metrics.scrollLeft + scrollDeltaX));

  return {
    scrollDeltaX,
    scrollDeltaY,
    nextScrollTop,
    nextScrollLeft,
    moved: nextScrollTop !== metrics.scrollTop || nextScrollLeft !== metrics.scrollLeft,
  };
}
