type TableInfoTextSelection = Pick<Selection, "isCollapsed" | "toString">;

export function shouldNavigateFromTableInfoColumnClick(selection?: TableInfoTextSelection | null): boolean {
  return !selection || selection.isCollapsed || selection.toString().length === 0;
}
