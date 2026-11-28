// @vitest-environment happy-dom

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installWebKitClipboardGuard } from "@/lib/common/webkitClipboardGuard";

const views: EditorView[] = [];
let dispose: () => void;

beforeEach(() => {
  dispose = installWebKitClipboardGuard();
});

afterEach(() => {
  dispose();
  views.splice(0).forEach((view) => view.destroy());
  document.body.replaceChildren();
});

function editor(anchor = 5, head = anchor) {
  const view = new EditorView({
    doc: "first\nsecond\nthird",
    selection: EditorSelection.single(anchor, head),
    parent: document.body,
  });
  views.push(view);
  view.focus();
  return view;
}

function keydown(target: HTMLElement, init: KeyboardEventInit = { key: "x", ctrlKey: true }) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function keyup(target: HTMLElement) {
  target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "x", ctrlKey: true }));
}

/** Dispatch a copy/cut event with a fake clipboardData and return what was written. */
function clipboard(target: HTMLElement, type = "cut") {
  const data = new Map<string, string>();
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      clearData: () => data.clear(),
      setData: (format: string, value: string) => data.set(format, value),
    },
  });
  target.dispatchEvent(event);
  return data.get("text/plain");
}

describe("installWebKitClipboardGuard", () => {
  it.each([
    { key: "x", ctrlKey: true },
    { key: "Delete", shiftKey: true },
  ])("cuts only the caret line for one $key keydown and two cut events", (shortcut) => {
    const view = editor();

    keydown(view.contentDOM, shortcut);

    expect(clipboard(view.contentDOM)).toBe("first");
    expect(clipboard(view.contentDOM)).toBeUndefined();
    expect(view.state.doc.toString()).toBe("second\nthird");
  });

  it("preserves a selected-text cut and the following line", () => {
    const view = editor(0, 5);

    keydown(view.contentDOM);

    expect(clipboard(view.contentDOM)).toBe("first");
    expect(clipboard(view.contentDOM)).toBeUndefined();
    expect(view.state.doc.toString()).toBe("\nsecond\nthird");
  });

  it("suppresses duplicate copies without changing the document", () => {
    const view = editor();

    keydown(view.contentDOM, { key: "c", ctrlKey: true });

    expect(clipboard(view.contentDOM, "copy")).toBe("first");
    expect(clipboard(view.contentDOM, "copy")).toBeUndefined();
    expect(view.state.doc.toString()).toBe("first\nsecond\nthird");
  });

  it("lets the next keystroke cut again", () => {
    const view = editor();

    keydown(view.contentDOM);
    expect(clipboard(view.contentDOM)).toBe("first");
    clipboard(view.contentDOM);
    keyup(view.contentDOM);

    keydown(view.contentDOM);
    expect(clipboard(view.contentDOM)).toBe("second");
    expect(view.state.doc.toString()).toBe("third");
  });
});
