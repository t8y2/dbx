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

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function createHarness(readOnly = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "abc def ghi", selection: { anchor: 4, head: 7 } }) });
  const position = vi.spyOn(view, "posAtCoords").mockReturnValue(5);
  vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 50, right: 51, top: 20, bottom: 38 });
  vi.spyOn(view, "focus").mockImplementation(() => {});
  const emit = vi.fn();
  const clearTableNavigationHover = vi.fn();
  const pointer = useQueryEditorPointer({ props: { modelValue: "abc def ghi", readOnly }, clearTableNavigationHover, emit });
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
