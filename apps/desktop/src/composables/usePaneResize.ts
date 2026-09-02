import { onBeforeUnmount, ref } from "vue";

const MIN_WIDTH_PERCENT = 20;
const MAX_WIDTH_PERCENT = 80;
export const DEFAULT_PANE_WIDTH_PERCENT = 40;

export function clampPaneWidthPercent(value: number): number {
  return Math.min(MAX_WIDTH_PERCENT, Math.max(MIN_WIDTH_PERCENT, value));
}

export function loadPaneWidthPercent(storageKey: string): number {
  if (typeof localStorage === "undefined") return DEFAULT_PANE_WIDTH_PERCENT;
  const raw = Number(localStorage.getItem(storageKey));
  return Number.isFinite(raw) && raw > 0 ? clampPaneWidthPercent(raw) : DEFAULT_PANE_WIDTH_PERCENT;
}

/**
 * Drag-to-resize helper for the split reference pane. The caller binds
 * `beginResize` to pointerdown on the divider and passes the pane row element
 * so the drag maps cursor position to a size percentage of that container.
 * The axis picks which divider orientation is being dragged: "x" resizes a
 * side-by-side layout by width, "y" a stacked layout by height.
 */
export function usePaneResize(storageKey: string, axis: "x" | "y") {
  const sizePercent = ref(loadPaneWidthPercent(storageKey));
  const isResizing = ref(false);
  let containerEl: HTMLElement | null = null;
  let containerSize = 0;
  let containerStart = 0;

  const saveSize = () => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(storageKey, String(sizePercent.value));
    } catch {
      /* storage unavailable (private mode) — keep the in-memory size */
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!containerEl) return;
    const position = axis === "y" ? event.clientY : event.clientX;
    sizePercent.value = clampPaneWidthPercent(((position - containerStart) / containerSize) * 100);
  };

  const stopResize = () => {
    if (!isResizing.value) return;
    isResizing.value = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopResize);
    saveSize();
  };

  const beginResize = (element: HTMLElement | null) => {
    if (!element) return;
    containerEl = element;
    const rect = element.getBoundingClientRect();
    containerSize = (axis === "y" ? rect.height : rect.width) || 1;
    containerStart = axis === "y" ? rect.top : rect.left;
    isResizing.value = true;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
  };

  onBeforeUnmount(stopResize);

  return { sizePercent, isResizing, beginResize };
}
