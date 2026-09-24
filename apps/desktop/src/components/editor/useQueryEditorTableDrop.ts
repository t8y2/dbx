import { ref, computed } from "vue";
import type { EditorView as EditorViewType } from "@codemirror/view";
import {
  DBX_TABLE_REFERENCE_MIME,
  DBX_TABLE_REFERENCE_DROP_EVENT,
  DBX_TABLE_REFERENCE_HOVER_EVENT,
  DBX_TABLE_REFERENCE_DRAG_END_EVENT,
  activeTableReferencePayloadValue,
  clearActiveTableReferencePayload,
  hasTableReferencePayloadType,
  parseTableReferencePayload,
  tableReferenceInsertText,
  type QueryEditorTableReferenceDropDetail,
  type QueryEditorTableReferenceHoverDetail,
  type QueryEditorTableReferencePayload,
} from "@/lib/editor/queryEditorTableDrop";
import { isPointOverElementRoot } from "@/lib/editor/tableReferenceDragFeedback";
import type { Ref } from "vue";
import type { QueryEditorProps } from "./queryEditorTypes";
import type { useSettingsStore } from "@/stores/settingsStore";

interface QueryEditorTableDropOptions {
  props: Readonly<QueryEditorProps>;
  view: Readonly<Ref<EditorViewType | null>>;
  editorRef: Readonly<Ref<HTMLElement | null | undefined>>;
  settingsStore: ReturnType<typeof useSettingsStore>;
}

export function useQueryEditorTableDrop(options: QueryEditorTableDropOptions) {
  const { props, view, editorRef, settingsStore } = options;
  let tableReferenceDropListenerRegistered = false;

  // --- 表引用拖拽悬停时的插入光标线（指针模拟拖拽经 window 事件驱动） ---
  const queryEditorDropCaret = ref<{ left: number; top: number; height: number } | null>(null);

  const queryEditorDropCaretStyle = computed(() => {
    const caret = queryEditorDropCaret.value;
    return caret ? { left: `${caret.left}px`, top: `${caret.top}px`, height: `${caret.height}px` } : {};
  });

  function droppedTableReference(event: DragEvent) {
    return activeTableReferencePayloadValue() ?? parseTableReferencePayload(event.dataTransfer?.getData(DBX_TABLE_REFERENCE_MIME));
  }

  function hasDroppedTableReference(event: DragEvent) {
    return !!activeTableReferencePayloadValue() || hasTableReferencePayloadType(event.dataTransfer?.types);
  }

  function insertTableReferencePayload(currentView: EditorViewType, payload: QueryEditorTableReferencePayload, coords?: { clientX: number; clientY: number }): boolean {
    if (props.readOnly) return false;
    const insertText = tableReferenceInsertText(payload, props.databaseType, {
      tableNameSeparator: settingsStore.editorSettings.sidebarCopyTableNameSeparator,
      columnNameSeparator: settingsStore.editorSettings.sidebarCopyTableNameSeparator,
      includeTableSchema: settingsStore.editorSettings.sidebarCopyTableNameIncludeSchema,
    });
    const dropPos = coords ? currentView.posAtCoords({ x: coords.clientX, y: coords.clientY }) : null;
    const selection = currentView.state.selection.main;
    const from = dropPos ?? selection.from;
    const to = dropPos == null && !selection.empty ? selection.to : from;
    currentView.dispatch({
      changes: { from, to, insert: insertText },
      selection: { anchor: from + insertText.length },
      scrollIntoView: true,
      userEvent: "input.drop",
    });
    clearActiveTableReferencePayload(payload);
    hideQueryEditorDropCaret();
    currentView.focus();
    return true;
  }

  function insertDroppedTableReference(currentView: EditorViewType, event: DragEvent): boolean {
    const payload = droppedTableReference(event);
    if (!payload) return false;

    event.preventDefault();
    event.stopPropagation();
    return insertTableReferencePayload(currentView, payload, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  function onTableReferenceDropEvent(event: Event) {
    const currentView = view.value;
    if (!currentView || props.readOnly || !(event instanceof CustomEvent)) return;
    const detail = event.detail as QueryEditorTableReferenceDropDetail | undefined;
    if (!detail?.payload) return;
    // elementFromPoint 被透明覆盖层拦截时回退为编辑器根节点包围盒判定（见 isPointOverElementRoot）。
    if (isPointOverElementRoot(detail.clientX, detail.clientY, editorRef.value)) {
      insertTableReferencePayload(currentView, detail.payload, detail);
    }
  }

  function showQueryEditorDropCaretAt(clientX: number, clientY: number) {
    const currentView = view.value;
    if (!currentView || props.readOnly || !editorRef.value) {
      hideQueryEditorDropCaret();
      return;
    }
    let dropPos: number | null = null;
    try {
      dropPos = currentView.posAtCoords({ x: clientX, y: clientY });
    } catch {
      dropPos = null;
    }
    if (dropPos == null) {
      hideQueryEditorDropCaret();
      return;
    }
    const coords = currentView.coordsAtPos(dropPos);
    if (!coords) {
      hideQueryEditorDropCaret();
      return;
    }
    const rect = editorRef.value.getBoundingClientRect();
    queryEditorDropCaret.value = { left: coords.left - rect.left, top: coords.top - rect.top, height: Math.max(coords.bottom - coords.top, 0) };
  }

  function hideQueryEditorDropCaret() {
    queryEditorDropCaret.value = null;
  }

  function onTableReferenceHoverEvent(event: Event) {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as QueryEditorTableReferenceHoverDetail | undefined;
    if (!detail) return;
    // elementFromPoint 被透明覆盖层拦截时回退为编辑器根节点包围盒判定（见 isPointOverElementRoot）。
    if (!isPointOverElementRoot(detail.clientX, detail.clientY, editorRef.value)) {
      hideQueryEditorDropCaret();
      return;
    }
    showQueryEditorDropCaretAt(detail.clientX, detail.clientY);
  }

  function onTableReferenceDragEndEvent() {
    hideQueryEditorDropCaret();
  }

  function registerTableReferenceDropListener() {
    if (tableReferenceDropListenerRegistered) return;
    window.addEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, onTableReferenceDropEvent);
    window.addEventListener(DBX_TABLE_REFERENCE_HOVER_EVENT, onTableReferenceHoverEvent);
    window.addEventListener(DBX_TABLE_REFERENCE_DRAG_END_EVENT, onTableReferenceDragEndEvent);
    tableReferenceDropListenerRegistered = true;
  }

  function unregisterTableReferenceDropListener() {
    if (!tableReferenceDropListenerRegistered) return;
    window.removeEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, onTableReferenceDropEvent);
    window.removeEventListener(DBX_TABLE_REFERENCE_HOVER_EVENT, onTableReferenceHoverEvent);
    window.removeEventListener(DBX_TABLE_REFERENCE_DRAG_END_EVENT, onTableReferenceDragEndEvent);
    tableReferenceDropListenerRegistered = false;
  }

  return { hasDroppedTableReference, insertDroppedTableReference, queryEditorDropCaret, queryEditorDropCaretStyle, showQueryEditorDropCaretAt, hideQueryEditorDropCaret, registerTableReferenceDropListener, unregisterTableReferenceDropListener };
}
