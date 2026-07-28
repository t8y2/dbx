import { reactive, readonly } from "vue";

export type TabDropPosition = "before" | "after";

interface TabDragState {
  active: boolean;
  draggedId: string | null;
  targetId: string | null;
  dropPosition: TabDropPosition | null;
  wasDragged: boolean;
  startX: number;
  startY: number;
}

const DRAG_THRESHOLD = 5;

const state = reactive<TabDragState>({
  active: false,
  draggedId: null,
  targetId: null,
  dropPosition: null,
  wasDragged: false,
  startX: 0,
  startY: 0,
});

let pending: {
  id: string;
  x: number;
  y: number;
  sourceEl: HTMLElement | null;
} | null = null;
let onDropCallback: ((draggedId: string, targetId: string, position: TabDropPosition) => void) | null = null;
let ghostEl: HTMLElement | null = null;

function createGhost(sourceEl: HTMLElement, x: number, y: number) {
  const ghost = document.createElement("div");
  const textNode = sourceEl.querySelector(".truncate");
  ghost.textContent = textNode?.textContent || "";
  ghost.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 9999;
    opacity: 0.9;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    border-radius: var(--dbx-radius-fixed-6);
    background: var(--background, #fff);
    border: 1px solid var(--border, #e5e7eb);
    max-width: 200px;
    height: 28px;
    padding: 0 12px;
    font-size: 12px;
    line-height: 28px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    left: ${x + 12}px;
    top: ${y - 14}px;
  `;
  document.body.appendChild(ghost);
  return ghost;
}

function moveGhost(x: number, y: number) {
  if (!ghostEl) return;
  ghostEl.style.left = `${x + 8}px`;
  ghostEl.style.top = `${y - 14}px`;
}

function removeGhost() {
  if (ghostEl) {
    ghostEl.remove();
    ghostEl = null;
  }
}

function onMouseMove(event: MouseEvent) {
  if (!pending && !state.active) return;

  if (pending && !state.active) {
    const dx = event.clientX - pending.x;
    const dy = event.clientY - pending.y;
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    state.active = true;
    state.wasDragged = true;
    state.draggedId = pending.id;
    state.startX = pending.x;
    state.startY = pending.y;
    if (pending.sourceEl) {
      ghostEl = createGhost(pending.sourceEl, event.clientX, event.clientY);
    }
    pending = null;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }

  if (state.active) {
    moveGhost(event.clientX, event.clientY);
  }
}

function onMouseUp() {
  if (state.active && state.draggedId && state.targetId && state.dropPosition && onDropCallback) {
    onDropCallback(state.draggedId, state.targetId, state.dropPosition);
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
  pending = null;
  removeGhost();
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

export function useTabDrag(onDrop: (draggedId: string, targetId: string, position: TabDropPosition) => void) {
  ensureListeners();
  onDropCallback = onDrop;

  function startDrag(event: MouseEvent, tabId: string) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, [data-tab-title-input]")) return;
    state.wasDragged = false;
    const el = (event.currentTarget as HTMLElement) || null;
    pending = { id: tabId, x: event.clientX, y: event.clientY, sourceEl: el };
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

  function clearTarget(tabId: string) {
    if (state.targetId === tabId) {
      state.targetId = null;
      state.dropPosition = null;
    }
  }

  return {
    state: readonly(state),
    startDrag,
    updateTarget,
    clearTarget,
  };
}
