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

export interface DragSortStartOptions {
  autoScroll?: boolean;
  scrollContainer?: HTMLElement | null;
  onEnd?: () => void;
}

export interface DragSortAutoScrollInput {
  pointerX: number;
  pointerY: number;
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

const DRAG_THRESHOLD = 5;
export const DRAG_SORT_AUTO_SCROLL_EDGE_SIZE = 40;
const DRAG_SORT_AUTO_SCROLL_HORIZONTAL_TOLERANCE = 32;
const DRAG_SORT_AUTO_SCROLL_MIN_SPEED = 4;
const DRAG_SORT_AUTO_SCROLL_MAX_SPEED = 20;

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
  autoScroll: boolean;
  scrollContainer: HTMLElement | null;
  onEnd: (() => void) | null;
} | null = null;
let onDropCallback: ((draggedId: string, targetId: string, position: DropPosition) => void) | null = null;
let onDragEndCallback: (() => void) | null = null;
let ghostEl: HTMLElement | null = null;
let autoScrollContainer: HTMLElement | null = null;
let autoScrollFrame = 0;
let pointerX = 0;
let pointerY = 0;
const dropTargetRefreshEvents = new WeakSet<MouseEvent>();

export function dragSortAutoScrollDelta({ pointerX, pointerY, rect, scrollTop, clientHeight, scrollHeight }: DragSortAutoScrollInput): number {
  if (pointerX < rect.left - DRAG_SORT_AUTO_SCROLL_HORIZONTAL_TOLERANCE || pointerX > rect.right + DRAG_SORT_AUTO_SCROLL_HORIZONTAL_TOLERANCE) return 0;

  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  let direction = 0;
  let edgeDistance = 0;

  if (pointerY < rect.top + DRAG_SORT_AUTO_SCROLL_EDGE_SIZE) {
    direction = -1;
    edgeDistance = Math.max(0, pointerY - rect.top);
  } else if (pointerY > rect.bottom - DRAG_SORT_AUTO_SCROLL_EDGE_SIZE) {
    direction = 1;
    edgeDistance = Math.max(0, rect.bottom - pointerY);
  } else {
    return 0;
  }

  if ((direction < 0 && scrollTop <= 0) || (direction > 0 && scrollTop >= maxScrollTop)) return 0;

  const intensity = Math.min(1, Math.max(0, (DRAG_SORT_AUTO_SCROLL_EDGE_SIZE - edgeDistance) / DRAG_SORT_AUTO_SCROLL_EDGE_SIZE));
  const speed = Math.round(DRAG_SORT_AUTO_SCROLL_MIN_SPEED + (DRAG_SORT_AUTO_SCROLL_MAX_SPEED - DRAG_SORT_AUTO_SCROLL_MIN_SPEED) * intensity);
  return direction * speed;
}

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
    border-radius: var(--dbx-radius-fixed-4);
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

function cancelAutoScroll() {
  if (autoScrollFrame) {
    window.cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = 0;
  }
}

function refreshDropTargetAtPointer(container: HTMLElement) {
  state.targetId = null;
  state.dropPosition = null;
  if (typeof document.elementFromPoint !== "function") return;
  const rect = container.getBoundingClientRect();
  const targetX = Math.min(Math.max(pointerX, rect.left + 1), rect.right - 1);
  const targetY = Math.min(Math.max(pointerY, rect.top + 1), rect.bottom - 1);
  const target = document.elementFromPoint(targetX, targetY);
  if (!target) return;
  const event = new MouseEvent("mousemove", {
    bubbles: true,
    clientX: pointerX,
    clientY: targetY,
    buttons: 1,
  });
  dropTargetRefreshEvents.add(event);
  target.dispatchEvent(event);
}

function autoScrollStep() {
  autoScrollFrame = 0;
  const container = autoScrollContainer;
  if (!state.active || !container) return;

  const delta = dragSortAutoScrollDelta({
    pointerX,
    pointerY,
    rect: container.getBoundingClientRect(),
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
    scrollHeight: container.scrollHeight,
  });
  if (!delta) return;

  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const previousScrollTop = container.scrollTop;
  container.scrollTop = Math.min(maxScrollTop, Math.max(0, previousScrollTop + delta));
  if (container.scrollTop !== previousScrollTop) refreshDropTargetAtPointer(container);

  scheduleAutoScroll();
}

function scheduleAutoScroll() {
  if (autoScrollFrame || !autoScrollContainer || !state.active) return;
  const delta = dragSortAutoScrollDelta({
    pointerX,
    pointerY,
    rect: autoScrollContainer.getBoundingClientRect(),
    scrollTop: autoScrollContainer.scrollTop,
    clientHeight: autoScrollContainer.clientHeight,
    scrollHeight: autoScrollContainer.scrollHeight,
  });
  if (!delta) return;
  autoScrollFrame = window.requestAnimationFrame(autoScrollStep);
}

function updateAutoScroll() {
  const container = autoScrollContainer;
  if (!container || !state.active) {
    cancelAutoScroll();
    return;
  }
  const delta = dragSortAutoScrollDelta({
    pointerX,
    pointerY,
    rect: container.getBoundingClientRect(),
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
    scrollHeight: container.scrollHeight,
  });
  if (!delta) {
    cancelAutoScroll();
    return;
  }
  scheduleAutoScroll();
}

function onMouseMove(event: MouseEvent) {
  if (dropTargetRefreshEvents.has(event)) return;
  if (!pending && !state.active) return;

  pointerX = event.clientX;
  pointerY = event.clientY;

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
    autoScrollContainer = pending.autoScroll ? (pending.scrollContainer ?? pending.sourceEl?.closest<HTMLElement>(".connection-tree-scroller") ?? null) : null;
    onDragEndCallback = pending.onEnd;
    pending = null;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }

  if (state.active) {
    moveGhost(event.clientX, event.clientY);
    updateAutoScroll();
  }
}

function onMouseUp() {
  if (state.active && state.draggedId && state.targetId && state.dropPosition && onDropCallback) {
    onDropCallback(state.draggedId, state.targetId, state.dropPosition);
  }
  reset();
}

function reset() {
  const endCallback = onDragEndCallback ?? pending?.onEnd ?? null;
  state.active = false;
  state.draggedId = null;
  state.draggedType = null;
  state.targetId = null;
  state.dropPosition = null;
  state.startX = 0;
  state.startY = 0;
  pending = null;
  onDragEndCallback = null;
  autoScrollContainer = null;
  pointerX = 0;
  pointerY = 0;
  cancelAutoScroll();
  removeGhost();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  endCallback?.();
}

let listenersAttached = false;

function ensureListeners() {
  if (listenersAttached) return;
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  listenersAttached = true;
}

export function useDragSort(onDrop: (draggedId: string, targetId: string, position: DropPosition) => void) {
  ensureListeners();
  onDropCallback = onDrop;

  function startDrag(event: MouseEvent, nodeId: string, nodeType: string, options: DragSortStartOptions = {}) {
    if (event.button !== 0) return;
    const el = (event.currentTarget as HTMLElement) || null;
    pending = {
      id: nodeId,
      type: nodeType,
      x: event.clientX,
      y: event.clientY,
      sourceEl: el,
      autoScroll: options.autoScroll === true,
      scrollContainer: options.scrollContainer ?? null,
      onEnd: options.onEnd ?? null,
    };
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
