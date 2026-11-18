// @vitest-environment happy-dom
import { EditorSelection, EditorState, Prec, StateEffect } from "@codemirror/state";
import { EditorView, rectangularSelection, type ViewUpdate } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryEditorMultiCursorMouseSelection } from "@/lib/editor/queryEditorMultiCursorMouseSelection";
import { startsQueryEditorRectangularSelection } from "@/lib/editor/queryEditorPointerSelection";

const views: EditorView[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function harness(ranges = [EditorSelection.range(0, 8)]) {
  const view = new EditorView({
    state: EditorState.create({
      doc: "order_no user_id status",
      selection: EditorSelection.create(ranges),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    }),
  });
  views.push(view);
  vi.spyOn(view, "focus").mockImplementation(() => {});
  vi.spyOn(view, "posAndSideAtCoords").mockImplementation(({ x }) => ({ pos: x, assoc: 1 }));
  return view;
}
const pointer = (pos: number, init: MouseEventInit = {}) =>
  new MouseEvent("mousedown", {
    button: 0,
    detail: 1,
    altKey: true,
    ctrlKey: true,
    shiftKey: true,
    clientX: pos,
    ...init,
  });
const bounds = (selection: EditorSelection) => selection.ranges.map(({ from, to }) => [from, to]);

describe("query editor independent multi-cursor mouse selection", () => {
  it("adds and removes ranges through CodeMirror mouse events with Shift held", () => {
    // Browsers deliver selectionchange asynchronously. happy-dom delivers it
    // synchronously during CodeMirror's DOM update, causing reentrant updates.
    const blockSynchronousSelectionChange = (event: Event) => event.stopImmediatePropagation();
    document.addEventListener("selectionchange", blockSynchronousSelectionChange, true);
    cleanups.push(() => document.removeEventListener("selectionchange", blockSynchronousSelectionChange, true));
    const view = harness();
    view.dispatch({ effects: StateEffect.appendConfig.of([Prec.highest(EditorView.mouseSelectionStyle.of(createQueryEditorMultiCursorMouseSelection)), rectangularSelection({ eventFilter: startsQueryEditorRectangularSelection })]) });
    document.body.append(view.dom);
    const click = (pos: number, detail: number) => {
      view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail, clientX: pos, ctrlKey: true, altKey: true, shiftKey: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, detail, clientX: pos, ctrlKey: true, altKey: true, shiftKey: true }));
    };
    click(11, 2);
    expect(bounds(view.state.selection)).toEqual([
      [0, 8],
      [9, 16],
    ]);
    click(19, 2);
    expect(bounds(view.state.selection)).toEqual([
      [0, 8],
      [9, 16],
      [17, 23],
    ]);
    click(11, 1);
    expect(bounds(view.state.selection)).toEqual([
      [0, 8],
      [17, 23],
    ]);
    view.dom.remove();
  });
  it.each([
    { ctrlKey: true, metaKey: false },
    { ctrlKey: false, metaKey: true },
  ])("adds a word while Shift and platform modifiers are held: %j", (modifiers) => {
    const view = harness();
    const event = pointer(11, { detail: 2, ...modifiers });
    const style = createQueryEditorMultiCursorMouseSelection(view, event)!;
    expect(bounds(style.get(event, true, true))).toEqual([
      [0, 8],
      [9, 16],
    ]);
  });

  it("removes the clicked range and keeps the other ranges", () => {
    const view = harness([EditorSelection.range(0, 8), EditorSelection.range(9, 16), EditorSelection.range(17, 23)]);
    const event = pointer(11);
    const result = createQueryEditorMultiCursorMouseSelection(view, event)!.get(event, true, true);
    expect(bounds(result)).toEqual([
      [0, 8],
      [17, 23],
    ]);
    expect(result.main.from).toBe(0);
  });

  it("adds a cursor without extending the main range", () => {
    const view = harness();
    const event = pointer(19);
    expect(bounds(createQueryEditorMultiCursorMouseSelection(view, event)!.get(event, true, true))).toEqual([
      [0, 8],
      [19, 19],
    ]);
  });

  it("keeps a nonempty selection when clicking its only range", () => {
    const view = harness();
    const event = pointer(4);
    expect(createQueryEditorMultiCursorMouseSelection(view, event)!.get(event, true, true).ranges.length).toBeGreaterThan(0);
  });

  it("adds a dragged range independently in either direction", () => {
    const view = harness();
    for (const [start, end] of [
      [10, 20],
      [20, 10],
    ]) {
      const style = createQueryEditorMultiCursorMouseSelection(view, pointer(start))!;
      expect(bounds(style.get(pointer(end), true, true))).toEqual([
        [0, 8],
        [10, 20],
      ]);
    }
  });

  it("maps the initial ranges when the document changes during a gesture", () => {
    const view = harness();
    const style = createQueryEditorMultiCursorMouseSelection(view, pointer(11, { detail: 2 }))!;
    const transaction = view.state.update({ changes: { from: 0, insert: "xx " } });
    view.update([transaction]);
    style.update({ docChanged: true, changes: transaction.changes } as ViewUpdate);
    expect(bounds(style.get(pointer(14), true, true))).toEqual([
      [3, 11],
      [12, 19],
    ]);
  });

  it.each([{ altKey: false }, { ctrlKey: false, metaKey: false }, { button: 1 }, { button: 2 }, { detail: 3 }])("leaves other gestures to their existing handlers: %j", (init) => {
    expect(createQueryEditorMultiCursorMouseSelection(harness(), pointer(11, init))).toBeNull();
  });
});
