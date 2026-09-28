// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { NATIVE_SELECTION_PARK_MIN_CHARS, isLargeEditorSelection, keepNativeSelectionParkedDuringDrag, parkEditorNativeSelection } from "../queryEditorNativeSelection";

const DOC = `SELECT ${"x".repeat(NATIVE_SELECTION_PARK_MIN_CHARS)}`;

interface FakeView {
  view: EditorView;
  contentDOM: HTMLElement;
  dispatch: ReturnType<typeof vi.fn>;
  selectedText: () => string;
  /** Move the editor's own selection, as a pointer gesture would. */
  setSelection: (from: number, to: number) => void;
  /** Re-publish the state selection as the browser selection. */
  publishSelection: () => void;
  /** The private CodeMirror internals the drag park shadows, when requested. */
  docView: { updateSelection: ReturnType<typeof vi.fn> } | null;
  observer: { selectionRange: { focusNode: Node | null }; readSelectionRange: ReturnType<typeof vi.fn> } | null;
}

/** Runs the park module's `requestAnimationFrame` loop by hand. */
function manualFrames() {
  const queue: Array<{ id: number; callback: () => void }> = [];
  let nextId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    const id = ++nextId;
    queue.push({ id, callback: () => callback(performance.now()) });
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    const index = queue.findIndex((entry) => entry.id === id);
    if (index >= 0) queue.splice(index, 1);
  });
  return {
    runFrame: () => {
      const next = queue.shift();
      expect(next).toBeDefined();
      next!.callback();
    },
  };
}

function fakeView(from: number, to: number, options: { withSelectionInternals?: boolean } = {}): FakeView {
  const dom = document.createElement("div");
  const contentDOM = document.createElement("div");
  const paragraph = document.createElement("p");
  const text = document.createTextNode(DOC);
  paragraph.appendChild(text);
  contentDOM.appendChild(paragraph);
  dom.appendChild(contentDOM);
  document.body.appendChild(dom);

  const range = { from, to, empty: from === to, head: to, anchor: from };
  const dispatch = vi.fn();
  const state = {
    selection: { main: range, ranges: [range] },
    lineBreak: "\n",
    readOnly: false,
    sliceDoc: (start: number, end: number) => DOC.slice(start, end),
  };
  // CodeMirror keeps `updateSelection` on the doc view's prototype, which is what
  // the suppression shadows on the instance and deletes again on release.
  const docView = options.withSelectionInternals ? (Object.create({ updateSelection: vi.fn() }) as { updateSelection: ReturnType<typeof vi.fn> }) : null;
  const observer = options.withSelectionInternals ? { selectionRange: { focusNode: null as Node | null }, readSelectionRange: vi.fn(() => true) } : null;
  const view = {
    root: document,
    dom,
    contentDOM,
    state,
    dispatch,
    domAtPos: (pos: number) => ({ node: text, offset: Math.min(pos, DOC.length) }),
    docView,
    observer,
  } as unknown as EditorView;

  const publishSelection = () => {
    const selection = document.getSelection()!;
    selection.collapse(text, range.from);
    selection.extend(text, range.to);
  };
  publishSelection();

  const setSelection = (nextFrom: number, nextTo: number) => {
    range.from = nextFrom;
    range.to = nextTo;
    range.empty = nextFrom === nextTo;
    range.anchor = nextFrom;
    range.head = nextTo;
  };

  return { view, contentDOM, dispatch, selectedText: () => document.getSelection()?.toString() ?? "", setSelection, publishSelection, docView, observer };
}

function copyEvent(target: EventTarget, type = "copy") {
  const data = { clearData: vi.fn(), setData: vi.fn() };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  target.dispatchEvent(event);
  return { data, event };
}

describe("parkEditorNativeSelection", () => {
  it("leaves short selections alone", () => {
    const { view } = fakeView(0, 5);
    expect(parkEditorNativeSelection(view)).toBeNull();
    expect(document.getSelection()?.toString()).toBe(DOC.slice(0, 5));
  });

  it("parks the browser selection outside the content element while the state keeps its selection", () => {
    const { view, contentDOM } = fakeView(10, 10 + NATIVE_SELECTION_PARK_MIN_CHARS);
    const park = parkEditorNativeSelection(view);

    expect(park).not.toBeNull();
    const selection = document.getSelection()!;
    expect(contentDOM.contains(selection.anchorNode)).toBe(false);
    expect(view.state.selection.main.to - view.state.selection.main.from).toBe(NATIVE_SELECTION_PARK_MIN_CHARS);

    park!.release();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it("fills the clipboard for a copy CodeMirror declined, using the injected normalizer", () => {
    const { view, contentDOM } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    const finalize = vi.fn((text: string) => text.replace(/\n/g, "\r\n"));
    const park = parkEditorNativeSelection(view, { finalizeClipboardText: finalize });

    const { data, event } = copyEvent(contentDOM);
    expect(finalize).toHaveBeenCalledWith(DOC.slice(0, NATIVE_SELECTION_PARK_MIN_CHARS));
    expect(data.setData).toHaveBeenCalledWith("text/plain", DOC.slice(0, NATIVE_SELECTION_PARK_MIN_CHARS).replace(/\n/g, "\r\n"));
    expect(event.defaultPrevented).toBe(true);

    park!.release();
  });

  it("cuts through its own path when CodeMirror declines", () => {
    const { view, contentDOM, dispatch } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    const park = parkEditorNativeSelection(view);

    const { data } = copyEvent(contentDOM, "cut");
    expect(data.setData).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ changes: [{ from: 0, to: NATIVE_SELECTION_PARK_MIN_CHARS }], userEvent: "delete.cut" }));

    park!.release();
  });

  it("stays out of the way when the editor already handled the copy", () => {
    const { view, contentDOM } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    const park = parkEditorNativeSelection(view);
    contentDOM.addEventListener("copy", (event) => event.preventDefault());

    const { data } = copyEvent(contentDOM);
    expect(data.setData).not.toHaveBeenCalled();

    park!.release();
  });

  it("stops listening once released", () => {
    const { view, contentDOM } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    const park = parkEditorNativeSelection(view)!;
    park.release();

    const { data } = copyEvent(contentDOM);
    expect(data.setData).not.toHaveBeenCalled();
  });
});

describe("isLargeEditorSelection", () => {
  it("only counts selections long enough to be worth parking", () => {
    const short = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS - 1);
    expect(isLargeEditorSelection(short.view)).toBe(false);

    const long = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    expect(isLargeEditorSelection(long.view)).toBe(true);

    const caret = fakeView(10, 10);
    expect(isLargeEditorSelection(caret.view)).toBe(false);
  });
});

describe("keepNativeSelectionParkedDuringDrag", () => {
  it("parks once the gesture has dragged out enough lines to be worth it", () => {
    const frames = manualFrames();
    const { view, contentDOM, setSelection } = fakeView(0, 4);
    const park = keepNativeSelectionParkedDuringDrag(view);

    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);

    setSelection(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    frames.runFrame();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    park.release();
  });

  it("leaves a gesture that never grows past a few lines alone", () => {
    const frames = manualFrames();
    const { view, contentDOM, setSelection, publishSelection } = fakeView(0, 4);
    const park = keepNativeSelectionParkedDuringDrag(view);

    setSelection(0, 40);
    publishSelection();
    frames.runFrame();
    frames.runFrame();

    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);

    park.release();
  });

  it("stops parking once the caller reports the gesture is over", () => {
    const frames = manualFrames();
    const { view, contentDOM, publishSelection } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    let dragging = true;
    const park = keepNativeSelectionParkedDuringDrag(view, { shouldKeepParked: () => dragging });

    publishSelection();
    frames.runFrame();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    dragging = false;
    publishSelection();
    frames.runFrame();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);

    park.release();
  });

  it("fills the clipboard for a copy taken while the gesture is still running", () => {
    manualFrames();
    const { view, contentDOM } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    const park = keepNativeSelectionParkedDuringDrag(view);

    const { data } = copyEvent(contentDOM);
    expect(data.setData).toHaveBeenCalledWith("text/plain", DOC.slice(0, NATIVE_SELECTION_PARK_MIN_CHARS));

    park.release();
  });

  it("re-parks after CodeMirror rewrites the browser selection from its own state", () => {
    const frames = manualFrames();
    const { view, contentDOM, publishSelection } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    const park = keepNativeSelectionParkedDuringDrag(view);

    // CodeMirror writes the browser selection on every selection update, which
    // puts a long selection back on the text services the parking exists to
    // keep away from it.
    publishSelection();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);

    frames.runFrame();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    park.release();
  });
});

describe("drag park selection-write suppression", () => {
  it("shadows CodeMirror's browser-selection write for the length of the park", () => {
    manualFrames();
    const { view, contentDOM, docView, observer } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS, { withSelectionInternals: true });
    const park = keepNativeSelectionParkedDuringDrag(view);

    // CodeMirror rewrites the browser selection on every selection update, and
    // a parked selection always looks stale to it, so the write is shadowed and
    // the read half is kept.
    expect(Object.prototype.hasOwnProperty.call(docView, "updateSelection")).toBe(true);
    docView!.updateSelection(true);
    expect(observer!.readSelectionRange).toHaveBeenCalled();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    park.release();
    expect(Object.prototype.hasOwnProperty.call(docView, "updateSelection")).toBe(false);
  });

  it("leaves a view that does not expose the internals it was written against untouched", () => {
    manualFrames();
    const { view, contentDOM } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    const park = keepNativeSelectionParkedDuringDrag(view);

    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);
    park.release();
  });

  it("does not shadow the write when the caller opts out", () => {
    manualFrames();
    const { view, docView } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS, { withSelectionInternals: true });
    const park = keepNativeSelectionParkedDuringDrag(view, { suppressEditorSelectionWrites: false });

    expect(Object.prototype.hasOwnProperty.call(docView, "updateSelection")).toBe(false);
    park.release();
  });

  it("never clobbers a write somebody else already owns", () => {
    manualFrames();
    const { view, docView } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS, { withSelectionInternals: true });
    const existing = vi.fn();
    docView!.updateSelection = existing;

    const park = keepNativeSelectionParkedDuringDrag(view);
    expect(docView!.updateSelection).toBe(existing);

    park.release();
    expect(docView!.updateSelection).toBe(existing);
  });

  it("waits for the gesture's own write and only restores when the selection is still parked", () => {
    const frames = manualFrames();
    const { view, contentDOM, setSelection } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS, { withSelectionInternals: true });
    const park = keepNativeSelectionParkedDuringDrag(view);
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    // The click that ends the gesture collapses the editor selection, and that
    // collapse is what CodeMirror writes into the browser. Restoring first would
    // re-create the whole selection only to have CodeMirror collapse it again.
    setSelection(0, 0);
    park.release();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    frames.runFrame();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it("leaves a browser selection CodeMirror wrote itself alone", () => {
    const frames = manualFrames();
    const { view, contentDOM, setSelection } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS, { withSelectionInternals: true });
    const park = keepNativeSelectionParkedDuringDrag(view);

    setSelection(0, 0);
    document.getSelection()!.collapse(view.contentDOM.querySelector("p")!.firstChild!, 7);
    park.release();
    frames.runFrame();

    // The parked selection is gone, so there is nothing to put back.
    expect(document.getSelection()!.anchorOffset).toBe(7);
    expect(contentDOM.contains(document.getSelection()!.anchorNode)).toBe(true);
  });

  it("still restores the menu park inside release, before the caller's next task", () => {
    const { view, contentDOM } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS);
    const park = parkEditorNativeSelection(view);
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    park!.release();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it("leaves the browser selection to a park that started before its deferred restore ran", () => {
    const frames = manualFrames();
    const { view, contentDOM } = fakeView(0, NATIVE_SELECTION_PARK_MIN_CHARS, { withSelectionInternals: true });
    const first = keepNativeSelectionParkedDuringDrag(view);
    first.release();

    const second = keepNativeSelectionParkedDuringDrag(view);
    frames.runFrame();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(false);

    second.release();
    frames.runFrame();
    expect(contentDOM.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);
  });
});
