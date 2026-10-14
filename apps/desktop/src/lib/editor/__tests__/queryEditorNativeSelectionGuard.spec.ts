// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { defaultKeymap, history, selectAll, undo } from "@codemirror/commands";
import { createQueryEditorNativeSelectionGuard, keepNativeSelectionParkedDuringDrag, parkEditorNativeSelection } from "../queryEditorNativeSelection";

const SQL = Array.from({ length: 200 }, (_, index) => `CREATE TABLE example_${index} (id INTEGER);`).join("\n");
const views: EditorView[] = [];

beforeEach(() => {
  // Browsers queue selectionchange; happy-dom dispatches it during collapse.
  const dispatch = document.dispatchEvent.bind(document);
  let selectionChangePending = false;
  vi.spyOn(document, "dispatchEvent").mockImplementation((event) => {
    if (event.type !== "selectionchange") return dispatch(event);
    if (!selectionChangePending) {
      selectionChangePending = true;
      queueMicrotask(() => {
        selectionChangePending = false;
        dispatch(event);
      });
    }
    return true;
  });
});

function createView(options: { enabled?: boolean; readOnly?: boolean } = {}) {
  const execute = vi.fn((view: EditorView) => {
    view.focus();
    return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  });
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: SQL,
      extensions: [
        history(),
        EditorState.readOnly.of(options.readOnly ?? false),
        EditorView.clipboardOutputFilter.of((text) => text.replaceAll("\n", "\r\n")),
        createQueryEditorNativeSelectionGuard(ViewPlugin, { enabled: options.enabled ?? true, inputHandler: EditorView.inputHandler, finalizeClipboardText: (text) => text.replaceAll("\n", "\r\n") }),
        keymap.of([{ key: "Meta-a", run: selectAll }, { key: "Meta-Enter", run: (currentView) => !!execute(currentView) }, ...defaultKeymap]),
      ],
    }),
  });
  views.push(view);
  view.focus();
  return { view, execute };
}

function press(view: EditorView, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function clipboard(view: EditorView, type: "copy" | "cut" | "paste", text = "") {
  const data = { clearData: vi.fn(), setData: vi.fn(), getData: vi.fn(() => text) };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  view.contentDOM.dispatchEvent(event);
  return { data, event };
}

function expectParked(view: EditorView) {
  expect(document.getSelection()?.anchorNode === view.contentDOM).toBe(true);
  expect(document.getSelection()?.isCollapsed).toBe(true);
  expect(view.state.selection.main.to - view.state.selection.main.from).toBe(SQL.length);
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("macOS long native selection guard", () => {
  it("parks Cmd+A before CodeMirror publishes the long DOM range and keeps execution intact", () => {
    const { view, execute } = createView();
    const extend = vi.spyOn(document.getSelection()!, "extend");

    expect(press(view, "a", { metaKey: true }).defaultPrevented).toBe(true);
    expectParked(view);
    expect(extend).not.toHaveBeenCalled();

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(press(view, "Enter", { metaKey: true }).defaultPrevented).toBe(true);
      view.dispatch({ selection: view.state.selection });
      expectParked(view);
    }
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.results.every((result) => result.value === SQL)).toBe(true);
    expect(extend).not.toHaveBeenCalled();
  });

  it("keeps native selection behavior when disabled", () => {
    const { view } = createView({ enabled: false });
    const extend = vi.spyOn(document.getSelection()!, "extend");
    selectAll(view);
    expect(extend).toHaveBeenCalled();
    expect(document.getSelection()?.toString()).not.toBe("");
  });

  it("leaves an incompatible selection implementation alone", () => {
    const { view } = createView();
    const internals = view as unknown as { docView: { updateSelection: () => void } };
    const original = internals.docView.updateSelection;
    const foreignWrite = vi.fn(() => original.call(internals.docView));
    internals.docView.updateSelection = foreignWrite;
    selectAll(view);
    expect(foreignWrite).toHaveBeenCalled();
    expect(internals.docView.updateSelection).toBe(foreignWrite);
    expect(document.getSelection()?.isCollapsed).toBe(false);
    expect(view.state.selection.main.to).toBe(SQL.length);
  });

  it("protects a long selection immediately on refocus", () => {
    const { view } = createView();
    selectAll(view);
    const other = document.body.appendChild(document.createElement("input"));
    other.focus();
    const extend = vi.spyOn(document.getSelection()!, "extend");
    view.focus();
    expectParked(view);
    expect(extend).not.toHaveBeenCalled();
  });

  it("restores small selections and the caret without a frame delay", () => {
    const { view } = createView();
    selectAll(view);
    view.dispatch({ selection: { anchor: 0, head: 6 } });
    expect(document.getSelection()?.toString()).toBe("CREATE");
    view.dispatch({ selection: { anchor: 3 } });
    const selection = document.getSelection()!;
    expect(view.posAtDOM(selection.anchorNode!, selection.anchorOffset)).toBe(3);
    expect(selection.isCollapsed).toBe(true);
  });

  it("copies the exact selected SQL with configured line endings", () => {
    const { view } = createView();
    selectAll(view);
    const { data, event } = clipboard(view, "copy");
    expect(event.defaultPrevented).toBe(true);
    expect(data.setData).toHaveBeenCalledWith("text/plain", SQL.replaceAll("\n", "\r\n"));
    expectParked(view);
  });

  it("cuts and pastes from editor state and preserves undo", () => {
    const { view } = createView();
    selectAll(view);
    clipboard(view, "cut");
    expect(view.state.doc.length).toBe(0);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(SQL);
    selectAll(view);
    expect(clipboard(view, "paste", "SELECT 42;").event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT 42;");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(SQL);
  });

  it("does not cut a read-only document", () => {
    const { view } = createView({ readOnly: true });
    selectAll(view);
    const { data } = clipboard(view, "cut");
    expect(data.setData).toHaveBeenCalledWith("text/plain", SQL.replaceAll("\n", "\r\n"));
    expect(view.state.doc.toString()).toBe(SQL);
  });

  it("restores a reversed selection before typing without changing its direction", () => {
    const { view } = createView();
    view.dispatch({ selection: EditorSelection.single(SQL.length, 0) });
    expectParked(view);
    press(view, "x");
    const selection = document.getSelection()!;
    expect(view.posAtDOM(selection.anchorNode!, selection.anchorOffset)).toBe(SQL.length);
    expect(view.posAtDOM(selection.focusNode!, selection.focusOffset)).toBe(0);
    view.dispatch(view.state.replaceSelection("x"));
    expect(view.state.doc.toString()).toBe("x");
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it("replaces the logical selection for native input without a keyboard event", () => {
    const { view } = createView();
    selectAll(view);
    const event = new InputEvent("beforeinput", { inputType: "insertText", data: "中文", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
    expect(view.state.doc.toString()).toBe("中文");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(SQL);
  });

  it("preserves registered input handlers for native replacement text", () => {
    const { view } = createView();
    const handler = vi.fn((currentView: EditorView) => {
      currentView.dispatch(currentView.state.replaceSelection("handled"));
      return true;
    });
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.inputHandler.of(handler)) });
    selectAll(view);
    view.contentDOM.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertReplacementText", data: "replacement", bubbles: true, cancelable: true }));
    expect(handler).toHaveBeenCalledWith(view, 0, SQL.length, "replacement", expect.any(Function));
    expect(view.state.doc.toString()).toBe("handled");
  });

  it.each([
    ["insertParagraph", "\n"],
    ["insertLineBreak", "\n"],
    ["deleteContentBackward", ""],
  ])("applies native %s to the logical selection", (inputType, expected) => {
    const { view } = createView();
    selectAll(view);
    const event = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(expected);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(SQL);
  });

  it("leaves the native selection available throughout IME composition", () => {
    const { view } = createView();
    selectAll(view);
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({ selection: view.state.selection });
    expect(view.contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
    view.dispatch(view.state.replaceSelection("中文"));
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    expect(view.state.doc.toString()).toBe("中文");
  });

  it.each(["menu-first", "drag-first"])("retains protection across overlapping menu and drag parks (%s)", (order) => {
    const { view, execute } = createView();
    selectAll(view);
    const drag = keepNativeSelectionParkedDuringDrag(view);
    const menu = parkEditorNativeSelection(view)!;
    expect(menu).not.toBeNull();
    if (order === "menu-first") {
      menu.release();
      drag.release();
    } else {
      drag.release();
      menu.release();
    }
    view.focus();
    press(view, "Enter", { metaKey: true });
    expectParked(view);
    expect(execute).toHaveReturnedWith(SQL);
  });

  it("does not reclaim selection from another focused control or during teardown", () => {
    const { view } = createView();
    selectAll(view);
    const other = document.body.appendChild(document.createElement("div"));
    other.contentEditable = "true";
    other.textContent = "Other editor";
    other.focus();
    document.getSelection()!.selectAllChildren(other);
    view.dispatch({ selection: view.state.selection });
    expect(document.getSelection()?.toString()).toBe("Other editor");
    view.destroy();
    expect(document.getSelection()?.toString()).toBe("Other editor");
  });
});
