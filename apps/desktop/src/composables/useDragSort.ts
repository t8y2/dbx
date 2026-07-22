import { reactive, readonly } from "vue";

export type DropPosition = "before" | "after" | "inside";

interface DragState {
  active: boolean;
  draggedId: string | null;
  draggedType: string | null;
  targetId: string | null;
  dropPosition: DropPosition | null;
  startX: number;
  startY: number;
}

const DRAG_THRESHOLD = 5;

const state = reactive<DragState>({
  active: false,
  draggedId: null,
  draggedType: null,
  targetId: null,
  dropPosition: null,
  startX: 0,
  startY: 0,
});

let pending: {
  id: string;
  type: string;
  x: number;
  y: number;
  sourceEl: HTMLElement | null;
} | null = null;
let onDropCallback: ((draggedId: string, draggedType: string, targetId: string, position: DropPosition) => void) | null = null;
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
    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    border-radius: 4px;
    background: var(--background, #fff);
    border: 1px solid var(--border, #e5e7eb);
    max-width: 200px;
    height: 24px;
    padding: 0 8px;
    font-size: 12px;
    line-height: 24px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    left: ${x + 12}px;
    top: ${y - 10}px;
  `;
  document.body.appendChild(ghost);
  return ghost;
}

function moveGhost(x: number, y: number) {
  if (!ghostEl) return;
  ghostEl.style.left = `${x + 8}px`;
  ghostEl.style.top = `${y - 12}px`;
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
    state.draggedId = pending.id;
    state.draggedType = pending.type;
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
  // Snapshot the drop intent before reset() clears it. Wrapping the callback
  // in try/finally guarantees the drag session is torn down (cursor restored,
  // ghost removed, state cleared) even if the user's drop handler throws —
  // without it, a single bad handler would leave the user with a stuck
  // "grabbing" cursor and no way to start a new drag.
  if (state.active && state.draggedId && state.draggedType && state.targetId && state.dropPosition && onDropCallback) {
    const draggedId = state.draggedId;
    const draggedType = state.draggedType;
    const targetId = state.targetId;
    const position = state.dropPosition;
    try {
      onDropCallback(draggedId, draggedType, targetId, position);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[useDragSort] drop handler threw", error);
    }
  }
  reset();
}

function reset() {
  state.active = false;
  state.draggedId = null;
  state.draggedType = null;
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
  // Listen for mouseup both on document (capture phase, default) and on
  // window (capture phase). The window listener is a safety net: if some
  // inner code attaches a non-capture listener that calls
  // stopImmediatePropagation on the same target, the document-capture
  // listener still fires, but in some browsers the document-capture
  // listener can be missed when an ancestor (e.g. <html>) swallows the
  // event. Listening on window covers that edge case so the drag session
  // can ALWAYS be torn down — otherwise a single rogue handler could
  // leave the user with a stuck "grabbing" cursor.
  document.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("mouseup", onMouseUp, true);
  listenersAttached = true;
}

export function useDragSort(onDrop: (draggedId: string, draggedType: string, targetId: string, position: DropPosition) => void) {
  ensureListeners();
  onDropCallback = onDrop;

  function startDrag(event: MouseEvent, nodeId: string, nodeType: string) {
    if (event.button !== 0) return;
    const el = (event.currentTarget as HTMLElement) || null;
    pending = { id: nodeId, type: nodeType, x: event.clientX, y: event.clientY, sourceEl: el };
  }

  function updateTarget(event: MouseEvent, nodeId: string, nodeType: string) {
    if (!state.active || nodeId === state.draggedId) {
      if (state.targetId === nodeId) {
        state.targetId = null;
        state.dropPosition = null;
      }
      return;
    }

    state.targetId = nodeId;

    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const third = rect.height / 3;

    if (nodeType === "connection-group" && y > third && y < rect.height - third) {
      state.dropPosition = "inside";
    } else if (y < rect.height / 2) {
      state.dropPosition = "before";
    } else {
      state.dropPosition = "after";
    }
  }

  function clearTarget(nodeId: string) {
    if (state.targetId === nodeId) {
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
