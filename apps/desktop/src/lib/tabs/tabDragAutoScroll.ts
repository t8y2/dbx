/** Distance (px) from a strip edge inside which a dragged tab starts scrolling the strip. */
export const TAB_DRAG_AUTO_SCROLL_EDGE = 48;
/** Fastest scroll speed (px per frame), reached at or beyond the strip edge. */
export const TAB_DRAG_AUTO_SCROLL_MAX_STEP = 18;

/**
 * How far to scroll a tab strip this frame while a tab is dragged over it.
 *
 * `position`, `start` and `end` are coordinates along the strip's scroll axis.
 * Returns a negative step near the start edge, a positive one near the end
 * edge and 0 elsewhere. The speed ramps up as the pointer nears the edge and
 * stays at the maximum once it is past it (dragging beyond the strip keeps
 * scrolling). The edge zone shrinks on a short strip so the two zones never meet.
 */
export function tabDragAutoScrollStep(position: number, start: number, end: number, edge = TAB_DRAG_AUTO_SCROLL_EDGE, maxStep = TAB_DRAG_AUTO_SCROLL_MAX_STEP): number {
  const zone = Math.min(edge, Math.max(0, (end - start) / 3));
  if (zone <= 0) return 0;
  if (position < start + zone) return -Math.ceil(maxStep * Math.min(1, (start + zone - position) / zone));
  if (position > end - zone) return Math.ceil(maxStep * Math.min(1, (position - (end - zone)) / zone));
  return 0;
}
