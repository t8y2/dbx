export const DEFAULT_SEARCH_SPLIT_RATIO = 0.5;
export const MIN_SEARCH_SPLIT_PANE_WIDTH = 180;

export function clampSearchSplitWidth({ containerWidth, desiredWidth }: { containerWidth: number; desiredWidth?: number }): number {
  const fallback = containerWidth * DEFAULT_SEARCH_SPLIT_RATIO;
  if (containerWidth <= MIN_SEARCH_SPLIT_PANE_WIDTH * 2) return fallback;

  const min = MIN_SEARCH_SPLIT_PANE_WIDTH;
  const max = containerWidth - MIN_SEARCH_SPLIT_PANE_WIDTH;
  return Math.min(Math.max(desiredWidth ?? fallback, min), max);
}
