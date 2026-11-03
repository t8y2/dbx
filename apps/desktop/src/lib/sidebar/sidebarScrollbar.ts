export interface SidebarScrollbarGeometryOptions {
  scrollOffset: number;
  viewportSize: number;
  contentSize: number;
  trackSize: number;
  minThumbSize?: number;
}

export interface SidebarScrollbarGeometry {
  thumbOffset: number;
  thumbSize: number;
  maxThumbOffset: number;
  maxScrollOffset: number;
}

export interface SidebarHorizontalWheelDeltaOptions {
  enabled: boolean;
  shiftKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  lineHeight?: number;
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

/** Returns the consumable horizontal movement for a Shift+wheel gesture. */
export function sidebarHorizontalWheelDelta({ enabled, shiftKey, deltaX, deltaY, deltaMode = 0, lineHeight = 16, scrollLeft, clientWidth, scrollWidth }: SidebarHorizontalWheelDeltaOptions): number {
  if (!enabled || !shiftKey || scrollWidth <= clientWidth) return 0;
  const unit = deltaMode === 1 ? lineHeight : deltaMode === 2 ? clientWidth : 1;
  const delta = (Math.abs(deltaX) > 0 ? deltaX : deltaY) * unit;
  if (delta === 0) return 0;
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, scrollLeft + delta));
  return nextScrollLeft - scrollLeft;
}

export function sidebarScrollbarGeometry({ scrollOffset, viewportSize, contentSize, trackSize, minThumbSize = 24 }: SidebarScrollbarGeometryOptions): SidebarScrollbarGeometry {
  if (trackSize <= 0 || contentSize <= viewportSize) {
    return { thumbOffset: 0, thumbSize: 0, maxThumbOffset: 0, maxScrollOffset: 0 };
  }

  const thumbSize = Math.max(minThumbSize, Math.min(trackSize, (viewportSize / contentSize) * trackSize));
  const maxThumbOffset = Math.max(0, trackSize - thumbSize);
  const maxScrollOffset = Math.max(1, contentSize - viewportSize);
  const thumbOffset = Math.min(maxThumbOffset, Math.max(0, (scrollOffset / maxScrollOffset) * maxThumbOffset));
  return { thumbOffset, thumbSize, maxThumbOffset, maxScrollOffset };
}
