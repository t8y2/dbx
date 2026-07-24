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
