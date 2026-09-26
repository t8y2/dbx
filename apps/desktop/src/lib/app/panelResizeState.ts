import { ref } from "vue";

/**
 * Global "a panel divider is being dragged" state.
 *
 * Resizing side panels or splitter panes changes the width of the CodeMirror
 * editor and the DataGrid on every frame. Both subtrees react to that with
 * expensive per-frame work (CodeMirror's requestMeasure walking every visible
 * line, ResizeObserver chains reading clientWidth/scrollWidth, which forces
 * synchronous layout for the whole document). Heavy components subscribe to
 * this flag to freeze measurement while a drag is in flight and re-sync once
 * it finishes, turning hundreds of forced reflows into a single relayout.
 */
const isPanelResizing = ref(false);
const pendingAfterResize = new Set<() => void>();

function setPanelResizingResyncClass(resizing: boolean) {
  if (typeof document === "undefined") return;
  document.body.classList.toggle("dbx-is-resizing", resizing);
}

/** Marks a drag as in flight. Idempotent: safe to call on every move event. */
export function beginPanelResize() {
  if (isPanelResizing.value) return;
  isPanelResizing.value = true;
  setPanelResizingResyncClass(true);
}

/** Ends the current drag (if any) and flushes registered re-sync callbacks. */
export function endPanelResize() {
  if (!isPanelResizing.value) return;
  isPanelResizing.value = false;
  setPanelResizingResyncClass(false);
  const callbacks = [...pendingAfterResize];
  pendingAfterResize.clear();
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      // A failed re-sync must not block the other subscribers.
    }
  }
}

/**
 * Registers a measurement callback to run when the in-flight drag ends.
 * Returns whether the caller should skip its own work right now — i.e.
 * `true` means "a drag is active, your callback was queued".
 */
export function deferUntilPanelResizeEnd(callback: () => void): boolean {
  if (!isPanelResizing.value) return false;
  pendingAfterResize.add(callback);
  return true;
}

export { isPanelResizing };
