import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";

export function objectBrowserTableSelectionAnchor(rows: readonly ObjectBrowserRow[], anchorId: string | null, currentId: string): string {
  if (anchorId && rows.some((row) => row.id === anchorId && row.type === "TABLE")) return anchorId;
  return currentId;
}

/**
 * Compute the contiguous table-id range for a shift-click in the object
 * browser, mirroring the sidebar tree's range-select behavior
 * (sidebarTreeSelection.ts): the range spans every row between the anchor
 * and the clicked row in visible order, but only TABLE rows are selectable
 * so non-table rows inside the span are dropped from the result.
 */
export function objectBrowserTableSelectionRange(rows: readonly ObjectBrowserRow[], anchorId: string, currentId: string): string[] {
  const anchorIndex = rows.findIndex((row) => row.id === anchorId);
  const currentIndex = rows.findIndex((row) => row.id === currentId);
  if (anchorIndex < 0 || currentIndex < 0) return rows.some((row) => row.id === currentId && row.type === "TABLE") ? [currentId] : [];
  const start = Math.min(anchorIndex, currentIndex);
  const end = Math.max(anchorIndex, currentIndex);
  return rows
    .slice(start, end + 1)
    .filter((row) => row.type === "TABLE")
    .map((row) => row.id);
}
