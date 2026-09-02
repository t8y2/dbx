import { reactive, readonly } from "vue";

export type TabDropPosition = "before" | "after";

export interface TabDragOptions {
  onMove?: (draggedId: string, event: MouseEvent) => void;
  onEnd?: (draggedId: string, event: MouseEvent) => boolean;
}

interface TabDragState {
  active: boolean;
  draggedId: string | null;
  targetId: string | null;
  dropPosition: TabDropPosition | null;
  suppressClick: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

// Many touchscreen digitizers report to the OS/webview as a plain HID mouse
// (no distinguishable pointerType), with tap contact-point drift well beyond
// what real mouse/trackpad click jitter produces. 24px absorbs that jitter
// while still requiring a clearly deliberate drag to reorder a tab.
export const TAB_DRAG_HORIZONTAL_THRESHOLD = 24;

const state = reactive<TabDragState>({
  active: false,
  draggedId: null,
  targetId: null,
  dropPosition: null,
  suppressClick: false,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
});

let pending: {
  id: string;
  x: number;
  y: number;
} | null = null;
let onDropCallback: ((draggedId: string, targetId: string, position: TabDropPosition) => boolean) | null = null;
let onMoveCallback: ((draggedId: string, event: MouseEvent) => void) | null = null;
let onEndCallback: ((draggedId: string, event: MouseEvent) => boolean) | null = null;
function onMouseMove(event: MouseEvent) {
  if (!pending && !state.active) return;

  if (pending && !state.active) {
    const dx = event.clientX - pending.x;
    if (Math.abs(dx) < TAB_DRAG_HORIZONTAL_THRESHOLD) return;
    state.active = true;
    state.draggedId = pending.id;
    state.startX = pending.x;
    state.startY = pending.y;
    state.currentX = event.clientX;
    state.currentY = event.clientY;
    pending = null;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }

  if (state.active) {
    state.currentX = event.clientX;
    state.currentY = event.clientY;
    if (state.draggedId) onMoveCallback?.(state.draggedId, event);
  }
}

function onMouseUp(event: MouseEvent) {
  state.suppressClick = false;
  if (state.active && state.draggedId) {
    if (state.targetId && state.dropPosition && onDropCallback) {
      state.suppressClick = onDropCallback(state.draggedId, state.targetId, state.dropPosition);
    }
    state.suppressClick = onEndCallback?.(state.draggedId, event) || state.suppressClick;
  }
  reset();
}

function reset() {
  state.active = false;
  state.draggedId = null;
  state.targetId = null;
  state.dropPosition = null;
  state.startX = 0;
  state.startY = 0;
  state.currentX = 0;
  state.currentY = 0;
  pending = null;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

let listenersAttached = false;

function ensureListeners() {
  if (listenersAttached) return;
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  listenersAttached = true;
}

export function useTabDrag(onDrop: (draggedId: string, targetId: string, position: TabDropPosition) => boolean, options: TabDragOptions = {}) {
  ensureListeners();
  onDropCallback = onDrop;
  onMoveCallback = options.onMove ?? null;
  onEndCallback = options.onEnd ?? null;

  function startDrag(event: MouseEvent, tabId: string) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, [data-tab-title-input]")) return;
    state.suppressClick = false;
    pending = { id: tabId, x: event.clientX, y: event.clientY };
  }

  function updateTarget(event: MouseEvent, tabId: string) {
    if (!state.active || tabId === state.draggedId) {
      if (state.targetId === tabId) {
        state.targetId = null;
        state.dropPosition = null;
      }
      return;
    }

    state.targetId = tabId;

    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = event.clientX - rect.left;

    state.dropPosition = x < rect.width / 2 ? "before" : "after";
  }

  function clearTarget(tabId?: string) {
    if (!tabId || state.targetId === tabId) {
      state.targetId = null;
      state.dropPosition = null;
    }
  }

  function cancelDrag() {
    reset();
  }

  return {
    state: readonly(state),
    startDrag,
    updateTarget,
    clearTarget,
    cancelDrag,
  };
}
