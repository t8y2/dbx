import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";

export function objectBrowserTableSelectionAnchor(rows: readonly ObjectBrowserRow[], anchorId: string | null, currentId: string): string {
  if (anchorId && rows.some((row) => row.id === anchorId)) return anchorId;
  return currentId;
}

/**
 * Compute the contiguous object-id range for a shift-click in the object
 * browser, mirroring the sidebar tree's range-select behavior:
 * the range spans every row between the anchor and the clicked row
 * in visible order.
 */
export function objectBrowserTableSelectionRange(rows: readonly ObjectBrowserRow[], anchorId: string, currentId: string): string[] {
  const anchorIndex = rows.findIndex((row) => row.id === anchorId);
  const currentIndex = rows.findIndex((row) => row.id === currentId);
  if (anchorIndex < 0 || currentIndex < 0) return rows.some((row) => row.id === currentId) ? [currentId] : [];
  const start = Math.min(anchorIndex, currentIndex);
  const end = Math.max(anchorIndex, currentIndex);
  return rows.slice(start, end + 1).map((row) => row.id);
}
