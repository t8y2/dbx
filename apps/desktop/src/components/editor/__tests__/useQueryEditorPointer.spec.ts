// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorPointer } from "../useQueryEditorPointer";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isMacOS } from "@/lib/backend/platform";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: vi.fn(() => false) }));
vi.mock("@/lib/backend/platform", () => ({ isMacOS: vi.fn(() => false) }));
const cleanups: Array<() => void> = [];

/** Lets the drag park's frame-deferred restore run. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

const LONG_DOC = Array.from({ length: 60 }, (_, index) => `select column_${index} from table_${index} where id = ${index};`).join("\n");

function createHarness(readOnly = false, options: { doc?: string; selection?: { anchor: number; head: number } } = {}) {
  const doc = options.doc ?? "abc def ghi";
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({ parent: host, state: EditorState.create({ doc, selection: options.selection ?? { anchor: 4, head: 7 } }) });
  const position = vi.spyOn(view, "posAtCoords").mockReturnValue(5);
  vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 50, right: 51, top: 20, bottom: 38 });
  vi.spyOn(view, "focus").mockImplementation(() => {});
  const emit = vi.fn();
  const clearTableNavigationHover = vi.fn();
  const pointer = useQueryEditorPointer({ props: { modelValue: doc, readOnly }, clearTableNavigationHover, emit });
  const start = (init: MouseEventInit = {}) => {
    const event = new MouseEvent("mousedown", { button: 0, detail: 1, clientX: 10, clientY: 10, cancelable: true, ...init });
    Object.defineProperty(event, "target", { value: view.contentDOM });
    return { handled: pointer.startEditorSelectionDrag(view, event), event };
  };
  const move = (init: MouseEventInit = {}) => document.dispatchEvent(new MouseEvent("mousemove", { clientX: 30, clientY: 10, cancelable: true, ...init }));
  const release = (init: MouseEventInit = {}) => document.dispatchEvent(new MouseEvent("mouseup", { clientX: 30, clientY: 10, cancelable: true, ...init }));
  cleanups.push(() => {
    pointer.dispose();
    view.destroy();
    host.remove();
  });
  return { host, view, position, emit, clearTableNavigationHover, pointer, start, move, release };
}

/**
 * Dispatches a mousedown the editor's own mouse-selection handler would try to
 * hit-test, which happy-dom cannot answer. The capture listener runs after the
 * guard under test and stops the event before CodeMirror sees it.
 */
function dispatchEditorMouseDown(view: EditorView, init: MouseEventInit = {}) {
  const block = (event: Event) => event.stopImmediatePropagation();
  view.contentDOM.addEventListener("mousedown", block, true);
  try {
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, ...init }));
  } finally {
    view.contentDOM.removeEventListener("mousedown", block, true);
  }
}

describe("QueryEditor pointer ownership", () => {
  it.each(["read-only", "non-primary", "shift", "double-click", "empty-selection", "outside-selection"])("does not capture %s gestures", (kind) => {
    const { view, position, start, emit } = createHarness(kind === "read-only");
    if (kind === "empty-selection") view.dispatch({ selection: { anchor: 4 } });
    if (kind === "outside-selection") position.mockReturnValue(0);
    const { handled, event } = start({ button: kind === "non-primary" ? 2 : 0, shiftKey: kind === "shift", detail: kind === "double-click" ? 2 : 1 });
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps clicks below the drag threshold as caret moves", () => {
    const { view, position, start, move, release, emit } = createHarness();
    expect(start().handled).toBe(true);
    move({ clientX: 12 });
    position.mockReturnValue(6);
    release({ clientX: 12 });
    expect(view.state.doc.toString()).toBe("abc def ghi");
    expect(view.state.selection.main.anchor).toBe(6);
    expect(view.state.selection.main.empty).toBe(true);
    expect(emit).toHaveBeenCalledWith("closeColumnPanel");
    expect(document.querySelector(".dbx-editor-selection-drop-cursor")).toBeNull();
  });

  it("keeps a click that drifts past the drag threshold on the selection a caret move", () => {
    const { view, position, start, move, release } = createHarness();
    expect(start().handled).toBe(true);
    position.mockReturnValue(6);
    move({ clientX: 20 });
    expect(document.querySelector(".dbx-editor-selection-drop-cursor")).toBeNull();
    expect(view.contentDOM.style.cursor).toBe("");
    release({ clientX: 20 });
    expect(view.state.doc.toString()).toBe("abc def ghi");
    expect(view.state.selection.main.anchor).toBe(6);
    expect(view.state.selection.main.empty).toBe(true);
  });

  it("keeps the selection when a drag is carried out and brought back onto it", () => {
    const { view, position, start, move, release } = createHarness();
    start();
    position.mockReturnValue(11);
    move();
    expect(view.contentDOM.style.cursor).toBe("move");
    position.mockReturnValue(6);
    release();
    expect(view.state.doc.toString()).toBe("abc def ghi");
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([4, 7]);
  });

  it("drops the move cursor when the window loses focus mid-drag", () => {
    const { view, position, start, move } = createHarness();
    start();
    position.mockReturnValue(11);
    move();
    expect(view.contentDOM.style.cursor).toBe("move");
    expect(document.querySelector(".dbx-editor-selection-drop-cursor")).not.toBeNull();
    window.dispatchEvent(new Event("blur"));
    expect(view.contentDOM.style.cursor).toBe("");
    expect(document.querySelector(".dbx-editor-selection-drop-cursor")).toBeNull();
  });

  it.each(["move", "control-copy", "command-copy"])("preserves %s text and selection mapping", (kind) => {
    const { view, position, start, move, release, emit } = createHarness();
    const modifiers = { ctrlKey: kind === "control-copy", metaKey: kind === "command-copy" };
    start(modifiers);
    position.mockReturnValue(11);
    move(modifiers);
    expect(document.querySelector(".dbx-editor-selection-drop-cursor")).not.toBeNull();
    expect(view.contentDOM.style.cursor).toBe(kind === "move" ? "move" : "copy");
    release(modifiers);
    expect(view.state.doc.toString()).toBe(kind === "move" ? "abc  ghidef" : "abc def ghidef");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("def");
    expect(view.contentDOM.style.cursor).toBe("");
    expect(document.querySelector(".dbx-editor-selection-drop-cursor")).toBeNull();
    if (kind !== "move") expect(emit).not.toHaveBeenCalled();
  });

  it.each(["escape", "dispose"])("cleans document listeners and overlays on %s", (action) => {
    const { view, position, pointer, start, move, release } = createHarness();
    start();
    position.mockReturnValue(11);
    move();
    const remove = vi.spyOn(document, "removeEventListener");
    if (action === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    else pointer.dispose();
    expect(document.querySelector(".dbx-editor-selection-drop-cursor")).toBeNull();
    expect(view.contentDOM.style.cursor).toBe("");
    for (const event of ["mousemove", "mouseup", "keydown"]) expect(remove).toHaveBeenCalledWith(event, expect.any(Function), true);
    release();
    expect(view.state.doc.toString()).toBe("abc def ghi");
  });

  it("replaces scrollbar capture listeners and removes them on disposal", () => {
    const { view, host, pointer, clearTableNavigationHover } = createHarness();
    Object.defineProperties(view.scrollDOM, { scrollHeight: { configurable: true, value: 300 }, clientHeight: { configurable: true, value: 100 }, offsetWidth: { configurable: true, value: 100 }, clientWidth: { configurable: true, value: 90 } });
    vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    const bubble = vi.fn();
    host.addEventListener("mousedown", bubble);
    pointer.registerEditorScrollbarPointerGuard(view);
    pointer.registerEditorScrollbarPointerGuard(view);
    view.scrollDOM.dispatchEvent(new MouseEvent("mousedown", { clientX: 95, clientY: 20, bubbles: true }));
    expect(clearTableNavigationHover).toHaveBeenCalledOnce();
    expect(bubble).not.toHaveBeenCalled();
    pointer.dispose();
    view.scrollDOM.dispatchEvent(new MouseEvent("mousedown", { clientX: 95, clientY: 20, bubbles: true }));
    expect(bubble).toHaveBeenCalledOnce();
  });

  it("parks a long selection for the length of a drag and restores it on release", async () => {
    const { view, pointer } = createHarness(false, { doc: LONG_DOC, selection: { anchor: 0, head: 1200 } });
    const anchorInsideContent = () => view.contentDOM.contains(document.getSelection()?.anchorNode ?? null);
    document.getSelection()!.collapse(view.contentDOM, 0);

    pointer.registerEditorNativeSelectionDragGuard(view);
    dispatchEditorMouseDown(view);
    expect(anchorInsideContent()).toBe(false);

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    // The restore waits a microtask so a collapse dispatched in the same task
    // replaces the selection instead of being overwritten by it.
    await nextFrame();
    expect(anchorInsideContent()).toBe(true);
  });

  it("leaves a short selection alone while dragging", () => {
    const { view, pointer } = createHarness();
    document.getSelection()!.collapse(view.contentDOM, 0);
    pointer.registerEditorNativeSelectionDragGuard(view);

    dispatchEditorMouseDown(view);
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  it("does not start a parking window for gestures outside the editor content", () => {
    const { view, pointer } = createHarness(false, { doc: LONG_DOC, selection: { anchor: 0, head: 1200 } });
    document.getSelection()!.collapse(view.contentDOM, 0);
    pointer.registerEditorNativeSelectionDragGuard(view);

    view.scrollDOM.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it("stops the parking window when the pointer comes back with the button already up", async () => {
    const { view, pointer } = createHarness(false, { doc: LONG_DOC, selection: { anchor: 0, head: 1200 } });
    document.getSelection()!.collapse(view.contentDOM, 0);
    pointer.registerEditorNativeSelectionDragGuard(view);

    dispatchEditorMouseDown(view);
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    document.dispatchEvent(new MouseEvent("mousemove", { buttons: 0, bubbles: true }));
    await nextFrame();
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it("replaces drag parking listeners and removes them on disposal", () => {
    const { view, pointer } = createHarness(false, { doc: LONG_DOC, selection: { anchor: 0, head: 1200 } });
    document.getSelection()!.collapse(view.contentDOM, 0);
    pointer.registerEditorNativeSelectionDragGuard(view);
    pointer.registerEditorNativeSelectionDragGuard(view);
    pointer.dispose();

    dispatchEditorMouseDown(view);
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it("cancels the browser's own drag session for the length of the gesture", () => {
    const { view, pointer } = createHarness(false, { doc: LONG_DOC, selection: { anchor: 0, head: 1200 } });
    document.getSelection()!.collapse(view.contentDOM, 0);
    pointer.registerEditorNativeSelectionDragGuard(view);
    dispatchEditorMouseDown(view);

    const during = new Event("dragstart", { bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);

    // The gesture is over, so the browser may drag again.
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    const after = new Event("dragstart", { bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("ends the parking window on the first non-modifier key so typing never lands inside a parked gesture", async () => {
    const { view, pointer } = createHarness(false, { doc: LONG_DOC, selection: { anchor: 0, head: 1200 } });
    document.getSelection()!.collapse(view.contentDOM, 0);
    pointer.registerEditorNativeSelectionDragGuard(view);

    dispatchEditorMouseDown(view);
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await nextFrame();
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it("prevents native macOS Tauri scrollbar focus changes outside editor content", () => {
    const { view, pointer } = createHarness();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(true);
    Object.defineProperties(view.scrollDOM, { scrollHeight: { configurable: true, value: 300 }, clientHeight: { configurable: true, value: 100 } });
    vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    pointer.registerEditorScrollbarPointerGuard(view);
    const event = new MouseEvent("mousedown", { clientX: 95, clientY: 20, bubbles: true, cancelable: true });
    view.scrollDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
