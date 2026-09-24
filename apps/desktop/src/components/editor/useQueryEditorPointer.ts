import type { EditorView as EditorViewType } from "@codemirror/view";
import { startsQueryEditorSelectionDrag } from "@/lib/editor/queryEditorPointerSelection";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isMacOS } from "@/lib/backend/platform";
import type { QueryEditorProps } from "./queryEditorTypes";

interface QueryEditorPointerOptions {
  props: Readonly<QueryEditorProps>;
  clearTableNavigationHover: () => void;
  emit: (event: "closeColumnPanel") => void;
}

export function useQueryEditorPointer(options: QueryEditorPointerOptions) {
  const { props, clearTableNavigationHover, emit } = options;
  let editorScrollbarPointerCleanup: (() => void) | null = null;

  let editorSelectionDragCleanup: (() => void) | null = null;

  let editorSelectionDropCursorEl: HTMLDivElement | null = null;

  const EDITOR_SCROLLBAR_POINTER_GUTTER_PX = 18;

  const EDITOR_SELECTION_DRAG_THRESHOLD_PX = 6;

  function isEditorScrollbarPointerEvent(currentView: EditorViewType, event: MouseEvent) {
    if (event.button !== 0) return false;
    const scrollDOM = currentView.scrollDOM;
    const rect = scrollDOM.getBoundingClientRect();
    const hasVerticalScrollbar = scrollDOM.scrollHeight > scrollDOM.clientHeight + 1;
    const hasHorizontalScrollbar = scrollDOM.scrollWidth > scrollDOM.clientWidth + 1;
    const verticalGutter = Math.max(scrollDOM.offsetWidth - scrollDOM.clientWidth, EDITOR_SCROLLBAR_POINTER_GUTTER_PX);
    const horizontalGutter = Math.max(scrollDOM.offsetHeight - scrollDOM.clientHeight, EDITOR_SCROLLBAR_POINTER_GUTTER_PX);
    const inVerticalScrollbar = hasVerticalScrollbar && event.clientX >= rect.right - verticalGutter && event.clientX <= rect.right;
    const inHorizontalScrollbar = hasHorizontalScrollbar && event.clientY >= rect.bottom - horizontalGutter && event.clientY <= rect.bottom;
    return inVerticalScrollbar || inHorizontalScrollbar;
  }

  function registerEditorScrollbarPointerGuard(currentView: EditorViewType) {
    editorScrollbarPointerCleanup?.();
    const onPointerDown = (event: MouseEvent) => {
      if (!isEditorScrollbarPointerEvent(currentView, event)) return;
      clearTableNavigationHover();
      event.stopPropagation();
      if (isTauriRuntime() && isMacOS() && !currentView.contentDOM.contains(event.target as Node | null)) {
        event.preventDefault();
      }
    };
    currentView.scrollDOM.addEventListener("mousedown", onPointerDown, true);
    editorScrollbarPointerCleanup = () => {
      currentView.scrollDOM.removeEventListener("mousedown", onPointerDown, true);
      editorScrollbarPointerCleanup = null;
    };
  }

  function selectedRangeAtPointer(currentView: EditorViewType, event: MouseEvent) {
    if (props.readOnly || event.button !== 0) return null;
    if (!currentView.contentDOM.contains(event.target as Node | null)) return null;
    const range = currentView.state.selection.main;
    if (range.empty) return null;
    const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    if (pos == null || pos < range.from || pos > range.to) return null;
    return {
      from: range.from,
      to: range.to,
      text: currentView.state.sliceDoc(range.from, range.to),
    };
  }

  function moveOrCopySelectionToPointer(currentView: EditorViewType, selection: { from: number; to: number; text: string }, event: MouseEvent) {
    const dropPos = currentView.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    if (dropPos == null) return false;
    const copy = event.ctrlKey || event.metaKey;
    if (!copy && dropPos >= selection.from && dropPos <= selection.to) return true;

    const insert = { from: dropPos, insert: selection.text };
    const changes = copy ? currentView.state.changes(insert) : currentView.state.changes([{ from: selection.from, to: selection.to }, insert]);
    currentView.dispatch({
      changes,
      selection: {
        anchor: changes.mapPos(dropPos, -1),
        head: changes.mapPos(dropPos, 1),
      },
      scrollIntoView: true,
      userEvent: copy ? "input.drop" : "move.drop",
    });
    currentView.focus();
    return true;
  }

  function hideEditorSelectionDropCursor() {
    editorSelectionDropCursorEl?.remove();
    editorSelectionDropCursorEl = null;
  }

  function updateEditorSelectionDropCursor(currentView: EditorViewType, event: MouseEvent) {
    const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    if (pos == null) {
      hideEditorSelectionDropCursor();
      return;
    }
    const coords = currentView.coordsAtPos(pos);
    if (!coords) {
      hideEditorSelectionDropCursor();
      return;
    }
    const ownerDocument = currentView.dom.ownerDocument;
    const cursor = editorSelectionDropCursorEl ?? ownerDocument.createElement("div");
    if (!editorSelectionDropCursorEl) {
      cursor.setAttribute("aria-hidden", "true");
      cursor.className = "dbx-editor-selection-drop-cursor";
      // Use a fixed overlay instead of CodeMirror's internal drop cursor layer so
      // the marker stays visible above selection layers, themes, and scrollers.
      cursor.style.position = "fixed";
      cursor.style.zIndex = "2147483647";
      cursor.style.width = "2px";
      cursor.style.pointerEvents = "none";
      cursor.style.backgroundImage = "repeating-linear-gradient(to bottom, #e879f9 0 4px, transparent 4px 7px)";
      cursor.style.filter = "drop-shadow(0 0 1px rgba(0, 0, 0, 0.7))";
      ownerDocument.body.appendChild(cursor);
      editorSelectionDropCursorEl = cursor;
    }
    cursor.style.left = `${Math.round(coords.left) - 1}px`;
    cursor.style.top = `${Math.round(coords.top)}px`;
    cursor.style.height = `${Math.max(16, Math.round(coords.bottom - coords.top))}px`;
  }

  function startEditorSelectionDrag(currentView: EditorViewType, event: MouseEvent): boolean {
    if (!startsQueryEditorSelectionDrag(event)) return false;

    const selection = selectedRangeAtPointer(currentView, event);
    if (!selection) return false;

    event.preventDefault();
    event.stopPropagation();
    if (!event.ctrlKey && !event.metaKey) {
      emit("closeColumnPanel");
    }
    editorSelectionDragCleanup?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const cleanup = () => {
      currentView.contentDOM.ownerDocument.removeEventListener("mousemove", onMove, true);
      currentView.contentDOM.ownerDocument.removeEventListener("mouseup", onUp, true);
      currentView.contentDOM.ownerDocument.removeEventListener("keydown", onKeyDown, true);
      hideEditorSelectionDropCursor();
      editorSelectionDragCleanup = null;
    };

    const onMove = (moveEvent: MouseEvent) => {
      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!dragging && distance < EDITOR_SELECTION_DRAG_THRESHOLD_PX) return;
      dragging = true;
      if (moveEvent.ctrlKey || moveEvent.metaKey) {
        currentView.contentDOM.style.cursor = "copy";
      } else {
        currentView.contentDOM.style.cursor = "move";
      }
      updateEditorSelectionDropCursor(currentView, moveEvent);
      moveEvent.preventDefault();
      moveEvent.stopImmediatePropagation();
    };

    const onUp = (upEvent: MouseEvent) => {
      cleanup();
      currentView.contentDOM.style.cursor = "";
      upEvent.preventDefault();
      upEvent.stopImmediatePropagation();
      if (dragging) {
        moveOrCopySelectionToPointer(currentView, selection, upEvent);
        return;
      }
      const pos = currentView.posAtCoords({
        x: upEvent.clientX,
        y: upEvent.clientY,
      });
      if (pos != null) {
        currentView.dispatch({
          selection: { anchor: pos },
          userEvent: "select.pointer",
        });
        currentView.focus();
      }
    };

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      cleanup();
      currentView.contentDOM.style.cursor = "";
      keyEvent.preventDefault();
      keyEvent.stopImmediatePropagation();
    };

    currentView.contentDOM.ownerDocument.addEventListener("mousemove", onMove, true);
    currentView.contentDOM.ownerDocument.addEventListener("mouseup", onUp, true);
    currentView.contentDOM.ownerDocument.addEventListener("keydown", onKeyDown, true);
    editorSelectionDragCleanup = () => {
      cleanup();
      currentView.contentDOM.style.cursor = "";
    };
    return true;
  }

  function dispose() {
    editorScrollbarPointerCleanup?.();
    editorSelectionDragCleanup?.();
  }

  return { registerEditorScrollbarPointerGuard, startEditorSelectionDrag, dispose };
}
