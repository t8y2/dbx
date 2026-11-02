/**
 * The "执行 SQL 文件" dialog renders its progress block as the last child of
 * the scrollable body, so the progress area starts below the fold once a file
 * is selected.  Execution scrolls that area into view and keeps it visible
 * while the user works at the bottom of the body; these helpers describe when
 * the body still counts as "at the bottom" so the behaviour stays testable
 * without a layout engine.
 */

/** Slack (px) that still counts as the bottom of the scrollable body. */
export const BOTTOM_STICK_THRESHOLD_PX = 24;

export interface ScrollPosition {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether the scrollable body sits at (or within a few pixels of) its bottom.
 * A body whose content fits entirely is always at its bottom.
 */
export function isScrolledToBottom({ scrollTop, scrollHeight, clientHeight }: ScrollPosition, threshold: number = BOTTOM_STICK_THRESHOLD_PX): boolean {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return false;
  const remaining = scrollHeight - Math.max(0, scrollTop) - clientHeight;
  return remaining <= threshold;
}
