import type { EditorView as EditorViewType } from "@codemirror/view";
import { startsQueryEditorSelectionDrag } from "@/lib/editor/queryEditorPointerSelection";
import { keepNativeSelectionParkedDuringDrag, type EditorNativeSelectionPark } from "@/lib/editor/queryEditorNativeSelection";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isMacOS } from "@/lib/backend/platform";
import type { QueryEditorProps } from "./queryEditorTypes";

interface QueryEditorPointerOptions {
  props: Readonly<QueryEditorProps>;
  clearTableNavigationHover: () => void;
  emit: (event: "closeColumnPanel") => void;
}

export interface QueryEditorNativeSelectionDragGuardOptions {
  /**
   * Applied to the text the parked copy path puts on the clipboard. Pass the
   * same normalizer the editor registers as `EditorView.clipboardOutputFilter`
   * (DBX rewrites line endings there) so a copy taken while the selection is
   * parked matches a copy taken while it is not.
   */
  finalizeClipboardText?: (text: string) => string;
}

export function useQueryEditorPointer(options: QueryEditorPointerOptions) {
  const { props, clearTableNavigationHover, emit } = options;
  let editorScrollbarPointerCleanup: (() => void) | null = null;

  let editorNativeSelectionParkCleanup: (() => void) | null = null;

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

  /**
   * Parks the browser selection for the length of a selection gesture.
   *
   * macOS 26/27 has the web view serialize the browser selection whenever the
   * pointer dwells on text services, at a cost that grows with the number of
   * highlighted runs the selection covers. That is why a long drag is only
   * smooth while the pointer stays at the edge of the editor (autoscrolling
   * never puts it back on the text) and stalls as soon as it moves up over the
   * lines it has already selected. Parking removes that cost; the editor keeps
   * its own selection, so nothing about the gesture's result changes. See
   * queryEditorNativeSelection.ts.
   *
   * The guard owns the whole gesture rather than a single mousedown/mouseup
   * pair: the window has to cover CodeMirror's own mouse selection, the app's
   * move/copy selection drag, and the autoscroll timer that keeps extending the
   * selection while the pointer is held at the edge. It also cancels the
   * browser's own drag session for that window, which would otherwise serialize
   * the selection and take the pointer over with it.
   */
  function registerEditorNativeSelectionDragGuard(currentView: EditorViewType, guardOptions: QueryEditorNativeSelectionDragGuardOptions = {}) {
    editorNativeSelectionParkCleanup?.();
    const doc = currentView.contentDOM.ownerDocument;
    const win = doc.defaultView ?? window;
    let park: EditorNativeSelectionPark | null = null;

    const stop = () => {
      park?.release();
      park = null;
      doc.removeEventListener("mouseup", onUp, true);
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("dragstart", blockNativeDrag, true);
      win.removeEventListener("blur", stop);
    };

    // macOS turns a press, or a few pixels of travel, on selected text into its
    // own drag session: it serializes the selection into drag data, puts up its
    // own cursor, and then follows the pointer across whatever sits underneath
    // — which is how a drag started in the editor ends up moving the selection
    // over the SQL library list. On macOS 26/27 that serialization is the same
    // per-run text-services cost the parking exists to remove, so a long
    // selection stalls for seconds before the cursor even changes. The editor
    // already implements its own move/copy drag (`startEditorSelectionDrag`), so
    // the browser's session is cancelled for the length of the gesture. The
    // column-header drag cancels the same event for the same reason — see
    // `blockColumnHeaderNativeInteraction` in useDataGridColumnLayout.ts.
    const blockNativeDrag = (event: Event) => event.preventDefault();

    // A release outside the window (or over another app) never reaches the
    // document, so a pointer that comes back with the button already up ends
    // the gesture instead of leaving the selection parked.
    const onMove = (event: MouseEvent) => {
      if ((event.buttons & 1) === 0) stop();
    };

    const onUp = () => stop();

    // A parked selection is invisible to CodeMirror by design, so the park must
    // never outlive the gesture: the first key that is not a modifier ends it,
    // which is what keeps typing (and IME) out of a parked window.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift" || event.key === "Alt" || event.key === "Control" || event.key === "Meta") return;
      stop();
    };

    const onDown = (event: MouseEvent) => {
      if (event.button !== 0 || !currentView.contentDOM.contains(event.target as Node | null)) return;
      stop();
      park = keepNativeSelectionParkedDuringDrag(currentView, { finalizeClipboardText: guardOptions.finalizeClipboardText });
      doc.addEventListener("mouseup", onUp, true);
      doc.addEventListener("mousemove", onMove, true);
      doc.addEventListener("keydown", onKeyDown, true);
      doc.addEventListener("dragstart", blockNativeDrag, true);
      win.addEventListener("blur", stop);
    };

    currentView.contentDOM.addEventListener("mousedown", onDown, true);
    editorNativeSelectionParkCleanup = () => {
      currentView.contentDOM.removeEventListener("mousedown", onDown, true);
      stop();
      editorNativeSelectionParkCleanup = null;
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

  /**
   * Whether the pointer is still over the text the press landed on.
   *
   * `posAtCoords` answers with the position the pointer is closest to, so a
   * pointer in the blank area right of a line answers with that line's end —
   * inside the selection whenever the line is part of it, which is exactly what
   * a click on a long selection has to be read as.
   */
  function pointerOverSelection(currentView: EditorViewType, event: MouseEvent, selection: { from: number; to: number }) {
    const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    return pos != null && pos >= selection.from && pos <= selection.to;
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

    const win = currentView.contentDOM.ownerDocument.defaultView ?? window;
    const cleanup = () => {
      currentView.contentDOM.ownerDocument.removeEventListener("mousemove", onMove, true);
      currentView.contentDOM.ownerDocument.removeEventListener("mouseup", onUp, true);
      currentView.contentDOM.ownerDocument.removeEventListener("keydown", onKeyDown, true);
      win.removeEventListener("blur", onCancel);
      hideEditorSelectionDropCursor();
      editorSelectionDragCleanup = null;
    };

    // A release outside the window never reaches the document, so without this
    // the drop cursor and the move/copy pointer would stay behind until the
    // next press.
    const onCancel = () => {
      cleanup();
      currentView.contentDOM.style.cursor = "";
    };

    const onMove = (moveEvent: MouseEvent) => {
      if (!dragging) {
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (distance < EDITOR_SELECTION_DRAG_THRESHOLD_PX) return;
        // A press that never leaves the selected text is a click that drifted,
        // not a text drag, and it has to keep behaving like a click: the browser
        // would place the caret where the pointer came up. Taking it over
        // instead swallowed the release — the drop landed back inside the
        // selection, `moveOrCopySelectionToPointer` had nothing to do, and a
        // long selection looked like it could not be cleared at all.
        if (pointerOverSelection(currentView, moveEvent, selection)) return;
        dragging = true;
      }
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
    win.addEventListener("blur", onCancel);
    editorSelectionDragCleanup = () => {
      cleanup();
      currentView.contentDOM.style.cursor = "";
    };
    return true;
  }

  function dispose() {
    editorScrollbarPointerCleanup?.();
    editorNativeSelectionParkCleanup?.();
    editorSelectionDragCleanup?.();
  }

  return { registerEditorScrollbarPointerGuard, registerEditorNativeSelectionDragGuard, startEditorSelectionDrag, dispose };
}
