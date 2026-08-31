// @vitest-environment happy-dom
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, lineNumbers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQueryEditorLineNumbersExtension, isWrappedLineNumberGutter } from "@/lib/editor/queryEditorLineNumbers";

class StatementRunMarker extends GutterMarker {}

const activeViews: EditorView[] = [];

function createEditor(showLineNumbers: boolean) {
  const lineNumbersCompartment = new Compartment();
  const runGutterCompartment = new Compartment();
  const runMarker = new StatementRunMarker();
  const selectLine = vi.fn((_view: EditorView, _line: { from: number; to: number }, _event: Event) => true);
  const view = new EditorView({
    state: EditorState.create({
      doc: "SELECT 1;\nSELECT 2;",
      extensions: [
        lineNumbersCompartment.of(
          buildQueryEditorLineNumbersExtension(lineNumbers, showLineNumbers, {
            domEventHandlers: { mousedown: selectLine },
          }),
        ),
        runGutterCompartment.of(
          gutter({
            class: "cm-run-statement-gutter",
            lineMarker: () => runMarker,
          }),
        ),
      ],
    }),
    parent: document.createElement("div"),
  });
  activeViews.push(view);
  return { lineNumbersCompartment, selectLine, view };
}

afterEach(() => {
  for (const view of activeViews.splice(0)) view.destroy();
});

describe("query editor line numbers", () => {
  it("only treats gutters taller than one visual row as wrapped", () => {
    expect(isWrappedLineNumberGutter(20.8, 20.8)).toBe(false);
    expect(isWrappedLineNumberGutter(21.6, 20.8)).toBe(false);
    expect(isWrappedLineNumberGutter(42, 20.8)).toBe(true);
  });

  it("keeps line selection behavior when enabled", () => {
    const { selectLine, view } = createEditor(true);
    const lineNumber = view.dom.querySelector<HTMLElement>(".cm-lineNumbers .cm-gutterElement");

    lineNumber?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));

    expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(selectLine).toHaveBeenCalledOnce();
  });

  it("reconfigures line numbers without removing the statement run gutter", () => {
    const { lineNumbersCompartment, view } = createEditor(true);

    expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(view.dom.querySelector(".cm-run-statement-gutter")).not.toBeNull();

    view.dispatch({
      effects: lineNumbersCompartment.reconfigure(buildQueryEditorLineNumbersExtension(lineNumbers, false, { domEventHandlers: {} })),
    });

    expect(view.dom.querySelector(".cm-lineNumbers")).toBeNull();
    expect(view.dom.querySelector(".cm-run-statement-gutter")).not.toBeNull();

    view.dispatch({
      effects: lineNumbersCompartment.reconfigure(buildQueryEditorLineNumbersExtension(lineNumbers, true, { domEventHandlers: {} })),
    });

    expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(view.dom.querySelector(".cm-run-statement-gutter")).not.toBeNull();
  });
});
