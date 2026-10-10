// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlDebugEditorExtension, refreshPlDebugEditorEffect, type PlDebugEditorSnapshot } from "@/lib/editor/codemirrorPlDebugEditor";

const DOC = "alpha\nbravo\ncharlie\ndelta\necho";
const activeViews: EditorView[] = [];

afterEach(() => {
  for (const view of activeViews.splice(0)) view.destroy();
});

function createEditor(initial: PlDebugEditorSnapshot = { breakpointLines: [], currentLine: null }, enabled = true) {
  let snapshot = initial;
  let isEnabled = enabled;
  const toggleBreakpoint = vi.fn();
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [
        createPlDebugEditorExtension({
          getSnapshot: () => snapshot,
          isEnabled: () => isEnabled,
          toggleBreakpoint,
        }),
      ],
    }),
    parent: document.createElement("div"),
  });
  activeViews.push(view);
  // The gutter's first element is CodeMirror's hidden width spacer, hence the +1
  // offsets when addressing a source line.
  const gutterElement = (lineNumber: number) => view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")[lineNumber];
  return {
    view,
    toggleBreakpoint,
    gutterElement,
    setSnapshot: (next: PlDebugEditorSnapshot) => {
      snapshot = next;
      view.dispatch({ effects: refreshPlDebugEditorEffect.of(null) });
    },
    setEnabled: (next: boolean) => {
      isEnabled = next;
    },
    gutter: () => view.dom.querySelector<HTMLElement>(".cm-lineNumbers"),
    // Gutter elements render the line number, so a marked element identifies the
    // source line it decorates.
    markedLines: () => [...view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")].filter((element) => element.classList.contains("cm-pl-debug-breakpoint")).map((element) => element.textContent),
    previewLines: () => [...view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")].filter((element) => element.classList.contains("cm-pl-debug-breakpoint-preview")).map((element) => element.textContent),
    highlightedLines: () => [...view.dom.querySelectorAll<HTMLElement>(".cm-line.cm-pl-debug-current-line")].map((element) => element.textContent),
  };
}

describe("PL debug editor decorations", () => {
  it("draws one gutter dot per breakpoint line", () => {
    const editor = createEditor({ breakpointLines: [3, 5], currentLine: null });

    expect(editor.markedLines()).toEqual(["3", "5"]);
  });

  it("ignores lines outside the document and duplicates", () => {
    const editor = createEditor({ breakpointLines: [0, -2, 2, 2, 99], currentLine: null });

    expect(editor.markedLines()).toEqual(["2"]);
  });

  it("clears every stale dot and redraws from the new snapshot", () => {
    const editor = createEditor({ breakpointLines: [1, 2], currentLine: null });

    editor.setSnapshot({ breakpointLines: [4], currentLine: null });

    expect(editor.markedLines()).toEqual(["4"]);
  });

  it("highlights the current execution line and clears it again", () => {
    const editor = createEditor({ breakpointLines: [], currentLine: 3 });

    expect(editor.highlightedLines()).toEqual(["charlie"]);

    editor.setSnapshot({ breakpointLines: [], currentLine: null });

    expect(editor.highlightedLines()).toEqual([]);
  });

  it("toggles a breakpoint from the line number gutter while the session is alive", () => {
    const editor = createEditor();

    editor.gutterElement(1)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));

    expect(editor.toggleBreakpoint).toHaveBeenCalledOnce();
  });

  it("keeps the gutter inert for a secondary button and outside a debug session", () => {
    const editor = createEditor();

    editor.gutterElement(1)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
    expect(editor.toggleBreakpoint).not.toHaveBeenCalled();

    editor.setEnabled(false);
    editor.gutterElement(1)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(editor.toggleBreakpoint).not.toHaveBeenCalled();
  });

  it("shows a hover preview dot only while the pointer is inside the gutter", () => {
    const editor = createEditor();

    editor.gutterElement(1)?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(editor.previewLines()).toEqual(["1"]);

    editor.gutter()?.dispatchEvent(new MouseEvent("mouseleave"));
    expect(editor.previewLines()).toEqual([]);
  });

  it("never previews on a line that already carries a breakpoint", () => {
    const editor = createEditor({ breakpointLines: [1, 2, 3, 4, 5], currentLine: null });

    editor.gutterElement(1)?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    expect(editor.previewLines()).toEqual([]);
    expect(editor.markedLines()).toEqual(["1", "2", "3", "4", "5"]);
  });
});
