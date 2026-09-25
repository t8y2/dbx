// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { reactive, shallowRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorTableDrop } from "../useQueryEditorTableDrop";
import {
  activeTableReferencePayloadValue,
  createTableReferenceDragEndEvent,
  createTableReferenceDropEvent,
  createTableReferenceHoverEvent,
  DBX_TABLE_REFERENCE_MIME,
  serializeTableReferencePayload,
  setActiveTableReferencePayload,
  type QueryEditorTableReferencePayload,
} from "@/lib/editor/queryEditorTableDrop";
import type { QueryEditorProps } from "../queryEditorTypes";

type Options = Parameters<typeof useQueryEditorTableDrop>[0];
const cleanups: Array<() => void> = [];
const payload: QueryEditorTableReferencePayload = { kind: "dbx-table-reference", connectionId: "connection", database: "demo", tableName: "users", referenceType: "column", columnName: "id" };

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setActiveTableReferencePayload(null);
  vi.restoreAllMocks();
});

function createHarness(overrides: Partial<QueryEditorProps> = {}, left = 0) {
  const props = reactive<QueryEditorProps>({ modelValue: "SELECT old", databaseType: "postgres", ...overrides });
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: props.modelValue, selection: { anchor: 7, head: 10 } }) });
  vi.spyOn(view, "focus").mockImplementation(() => {});
  const position = vi.spyOn(view, "posAtCoords").mockReturnValue(10);
  const coordinates = vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: left + 25, right: left + 26, top: 30, bottom: 48 });
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(left, 20, 200, 100));
  const settings = reactive({ editorSettings: { sidebarCopyTableNameSeparator: "comma", sidebarCopyTableNameIncludeSchema: false } });
  const drop = useQueryEditorTableDrop({ props, view: shallowRef(view), editorRef: shallowRef(host), settingsStore: settings as Options["settingsStore"] });
  cleanups.push(() => {
    drop.unregisterTableReferenceDropListener();
    view.destroy();
    host.remove();
  });
  const nativeEvent = (serialized = serializeTableReferencePayload(payload)) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData(DBX_TABLE_REFERENCE_MIME, serialized);
    const event = new DragEvent("drop", { clientX: left + 30, clientY: 40, cancelable: true, bubbles: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    return event;
  };
  return { props, host, view, position, coordinates, settings, drop, nativeEvent };
}

describe("QueryEditor table-reference drop ownership", () => {
  it("inserts native references at the pointer and clears the hover caret", () => {
    const { view, drop, nativeEvent } = createHarness();
    drop.showQueryEditorDropCaretAt(30, 40);
    const event = nativeEvent();
    expect(drop.hasDroppedTableReference(event)).toBe(true);
    expect(drop.insertDroppedTableReference(view, event)).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT oldid");
    expect(view.state.selection.main.anchor).toBe(12);
    expect(event.defaultPrevented).toBe(true);
    expect(drop.queryEditorDropCaret.value).toBeNull();
  });

  it("uses the active pointer payload before native transfer data", () => {
    const { view, drop, nativeEvent } = createHarness();
    setActiveTableReferencePayload({ ...payload, columnName: "name" });
    expect(drop.insertDroppedTableReference(view, nativeEvent())).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT oldname");
    expect(activeTableReferencePayloadValue()).toBeNull();
  });

  it("falls back to replacing the selection when no pointer position is available", () => {
    const { view, position, drop, nativeEvent } = createHarness();
    position.mockReturnValue(null);
    expect(drop.insertDroppedTableReference(view, nativeEvent())).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT id");
    expect(view.state.selection.main.head).toBe(9);
  });

  it("ignores malformed payloads without consuming unrelated drops", () => {
    const { view, drop, nativeEvent } = createHarness();
    const event = nativeEvent("not-json");
    expect(drop.insertDroppedTableReference(view, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe("SELECT old");
  });

  it("leaves read-only documents and active payloads unchanged", () => {
    const { view, drop, nativeEvent } = createHarness({ readOnly: true });
    setActiveTableReferencePayload(payload);
    expect(drop.insertDroppedTableReference(view, nativeEvent())).toBe(false);
    expect(view.state.doc.toString()).toBe("SELECT old");
    expect(activeTableReferencePayloadValue()).toBe(payload);
    drop.showQueryEditorDropCaretAt(30, 40);
    expect(drop.queryEditorDropCaret.value).toBeNull();
  });

  it("converts viewport coordinates to the local caret and clears failed positions", () => {
    const { drop, position, coordinates } = createHarness({}, 100);
    drop.showQueryEditorDropCaretAt(130, 40);
    expect(drop.queryEditorDropCaretStyle.value).toEqual({ left: "25px", top: "10px", height: "18px" });
    coordinates.mockReturnValue(null);
    drop.showQueryEditorDropCaretAt(130, 40);
    expect(drop.queryEditorDropCaret.value).toBeNull();
    position.mockImplementation(() => {
      throw new Error("view unavailable");
    });
    expect(() => drop.showQueryEditorDropCaretAt(130, 40)).not.toThrow();
    expect(drop.queryEditorDropCaretStyle.value).toEqual({});
  });

  it("registers global listeners once and supports unregistering and reactivation", () => {
    const { view, drop } = createHarness();
    drop.registerTableReferenceDropListener();
    drop.registerTableReferenceDropListener();
    window.dispatchEvent(createTableReferenceDropEvent({ payload, clientX: 30, clientY: 40 }));
    expect(view.state.doc.toString()).toBe("SELECT oldid");
    drop.unregisterTableReferenceDropListener();
    window.dispatchEvent(createTableReferenceDropEvent({ payload, clientX: 30, clientY: 40 }));
    expect(view.state.doc.toString()).toBe("SELECT oldid");
    drop.registerTableReferenceDropListener();
    window.dispatchEvent(createTableReferenceHoverEvent({ clientX: 30, clientY: 40 }));
    expect(drop.queryEditorDropCaret.value).not.toBeNull();
    window.dispatchEvent(createTableReferenceDragEndEvent());
    expect(drop.queryEditorDropCaret.value).toBeNull();
  });

  it("keeps drops and hover carets isolated between editors", () => {
    const first = createHarness();
    const second = createHarness({}, 300);
    first.drop.registerTableReferenceDropListener();
    second.drop.registerTableReferenceDropListener();
    window.dispatchEvent(createTableReferenceHoverEvent({ clientX: 330, clientY: 40 }));
    expect(first.drop.queryEditorDropCaret.value).toBeNull();
    expect(second.drop.queryEditorDropCaret.value).not.toBeNull();
    window.dispatchEvent(createTableReferenceDropEvent({ payload, clientX: 330, clientY: 40 }));
    expect(first.view.state.doc.toString()).toBe("SELECT old");
    expect(second.view.state.doc.toString()).toBe("SELECT oldid");
  });
});
