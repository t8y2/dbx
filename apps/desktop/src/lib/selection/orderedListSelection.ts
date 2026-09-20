export type OrderedListSelectionIntent = "range" | "toggle" | "single";

export interface OrderedListSelectionItem {
  type: string;
  id: string;
}

export function orderedListSelectionIntent(event: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">): OrderedListSelectionIntent {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey) return "toggle";
  return "single";
}

export function orderedListRangeAnchorIndex(items: OrderedListSelectionItem[], anchorIndex: number | null, activeItem: OrderedListSelectionItem | null): number | null {
  if (anchorIndex !== null && anchorIndex >= 0 && anchorIndex < items.length) return anchorIndex;
  if (!activeItem) return null;
  const index = items.findIndex((item) => item.type === activeItem.type && item.id === activeItem.id);
  return index >= 0 ? index : null;
}

/** Inclusive, clamped index range between two positions in an ordered list. */
export function orderedListRangeIndices(length: number, anchorIndex: number, focusIndex: number): number[] {
  if (length <= 0) return [];
  if (anchorIndex < 0 || anchorIndex >= length || focusIndex < 0 || focusIndex >= length) return [];
  const start = Math.min(anchorIndex, focusIndex);
  const end = Math.max(anchorIndex, focusIndex);
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}
