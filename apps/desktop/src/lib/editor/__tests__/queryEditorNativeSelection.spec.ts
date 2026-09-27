// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { NATIVE_SELECTION_PARK_MIN_CHARS, parkEditorNativeSelection } from "../queryEditorNativeSelection";

const DOC = `SELECT ${"x".repeat(NATIVE_SELECTION_PARK_MIN_CHARS)}`;

interface FakeView {
  view: EditorView;
  contentDOM: HTMLElement;
  dispatch: ReturnType<typeof vi.fn>;
  selectedText: () => string;
}

function fakeView(from: number, to: number): FakeView {
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
  const view = {
    root: document,
    dom,
    contentDOM,
    state,
    dispatch,
    domAtPos: (pos: number) => ({ node: text, offset: Math.min(pos, DOC.length) }),
  } as unknown as EditorView;

  const selection = document.getSelection()!;
  selection.collapse(text, from);
  selection.extend(text, to);

  return { view, contentDOM, dispatch, selectedText: () => document.getSelection()?.toString() ?? "" };
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
