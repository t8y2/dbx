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
