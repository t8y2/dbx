export interface SidebarTypeSearchKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

export function isEditableSidebarTypeSearchTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest("input, textarea, select, [contenteditable='true'], .cm-editor");
}

export function sidebarTypeSearchNextQuery(currentQuery: string, event: SidebarTypeSearchKeyEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;

  if (event.key === "Backspace") {
    if (!currentQuery) return null;
    return currentQuery.slice(0, -1);
  }

  if (event.key.length !== 1) return null;
  if (event.key === " " && !currentQuery.trim()) return null;
  return `${currentQuery}${event.key}`;
}
