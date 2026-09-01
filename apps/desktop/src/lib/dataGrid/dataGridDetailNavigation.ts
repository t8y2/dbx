import { eventTargetUsesNativeClipboard } from "@/lib/common/clipboard";

export type DataGridDetailNavigationDelta = -1 | 1;
export type DataGridDetailNavigationAxis = "row" | "column";

const nestedOverlaySelector = "[data-slot='dropdown-menu-content'], [data-slot='popover-content'], [data-slot='dialog-content'], [role='menu'], [role='listbox']";

/** Return the adjacent index without wrapping past either end of the displayed list. */
export function adjacentDataGridDetailIndex(currentIndex: number, delta: DataGridDetailNavigationDelta, itemCount: number): number | null {
  const nextIndex = currentIndex + delta;
  if (currentIndex < 0 || currentIndex >= itemCount || nextIndex < 0 || nextIndex >= itemCount) return null;
  return nextIndex;
}

export function detailNavigationDelta(key: string, axis: DataGridDetailNavigationAxis): DataGridDetailNavigationDelta | null {
  if (axis === "row") {
    if (key === "ArrowUp") return -1;
    if (key === "ArrowDown") return 1;
  } else {
    if (key === "ArrowLeft") return -1;
    if (key === "ArrowRight") return 1;
  }
  return null;
}

function closestElement(target: EventTarget | null, selector: string): unknown {
  return (target as { closest?: (selector: string) => unknown } | null)?.closest?.(selector) ?? null;
}

export function shouldIgnoreDataGridDetailNavigation(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || eventTargetUsesNativeClipboard(event)) return true;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
  const overlay = closestElement(event.target, nestedOverlaySelector);
  return overlay !== null && overlay !== event.currentTarget;
}
