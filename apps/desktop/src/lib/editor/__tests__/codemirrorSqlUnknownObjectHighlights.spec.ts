// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqlUnknownObjectHighlights, refreshSqlUnknownObjectHighlights, setSqlUnknownObjectSpans, type SqlUnknownObjectSpan } from "@/lib/editor/codemirrorSqlUnknownObjectHighlights";

const DOC = "SELECT USER_ID FROM T";

let view: EditorView | null = null;

function mount(doc: string, options: { enabled?: boolean; load?: (view: EditorView) => Promise<SqlUnknownObjectSpan[]> } = {}) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        createSqlUnknownObjectHighlights({
          enabled: options.enabled ?? true,
          load: options.load ?? (async () => []),
          initialDelayMs: 0,
          debounceMs: 0,
        }),
      ],
    }),
  });
  return view;
}

/** Let the zero-delay deferred task fire and its promise chain settle. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function highlightedText(current: EditorView): string[] {
  return Array.from(current.dom.querySelectorAll(".cm-sql-unknown-object")).map((element) => element.textContent ?? "");
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

describe("createSqlUnknownObjectHighlights", () => {
  it("returns no extension when disabled", () => {
    expect(createSqlUnknownObjectHighlights({ enabled: false, load: async () => [], initialDelayMs: 0, debounceMs: 0 })).toEqual([]);
  });

  it("colours the ranges supplied through the effect", () => {
    const current = mount(DOC);
    current.dispatch({ effects: setSqlUnknownObjectSpans.of([{ from: 7, to: 14 }]) });

    expect(highlightedText(current)).toEqual(["USER_ID"]);

    current.dispatch({ effects: setSqlUnknownObjectSpans.of([]) });
    expect(highlightedText(current)).toEqual([]);
  });

  it("clamps, dedupes and orders the supplied ranges", () => {
    const current = mount(DOC);
    current.dispatch({
      effects: setSqlUnknownObjectSpans.of([
        { from: 15, to: 500 },
        { from: 7, to: 14 },
        { from: 7, to: 14 },
        { from: 3, to: 3 },
      ]),
    });

    // Ordered by start, duplicate collapsed, out-of-range clipped to the document end, empty dropped.
    expect(highlightedText(current)).toEqual(["USER_ID", "FROM T"]);
  });

  it("shifts existing highlights through document changes without clearing them", () => {
    const current = mount(DOC);
    current.dispatch({ effects: setSqlUnknownObjectSpans.of([{ from: 7, to: 14 }]) });

    current.dispatch({ changes: { from: 0, insert: "XX" } });

    expect(highlightedText(current)).toEqual(["USER_ID"]);
  });

  it("runs load on mount and applies the resolved spans", async () => {
    const load = vi.fn(async () => [{ from: 7, to: 14 }]);
    const current = mount(DOC, { load });

    expect(highlightedText(current)).toEqual([]);
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(highlightedText(current)).toEqual(["USER_ID"]);
  });

  it("re-runs load when a refresh effect is dispatched", async () => {
    const load = vi.fn(async () => [{ from: 7, to: 14 }]);
    const current = mount(DOC, { load });
    await settle();
    expect(load).toHaveBeenCalledTimes(1);

    current.dispatch({ effects: refreshSqlUnknownObjectHighlights.of(null) });
    await settle();

    expect(load).toHaveBeenCalledTimes(2);
    expect(highlightedText(current)).toEqual(["USER_ID"]);
  });

  it("discards a result computed against an older document", async () => {
    let resolveLoad: ((spans: SqlUnknownObjectSpan[]) => void) | null = null;
    const load = () =>
      new Promise<SqlUnknownObjectSpan[]>((resolve) => {
        resolveLoad = resolve;
      });
    const current = mount(DOC, { load });
    await settle();

    current.dispatch({ changes: { from: 0, insert: "XX" } });
    resolveLoad?.([{ from: 7, to: 14 }]);
    await settle();

    expect(highlightedText(current)).toEqual([]);
  });

  it("ignores a load failure", async () => {
    const load = async () => {
      throw new Error("metadata unavailable");
    };
    const current = mount(DOC, { load });
    await settle();

    expect(highlightedText(current)).toEqual([]);
  });

  it("emits an !important colour rule that outranks the table-name colour", () => {
    mount(DOC);
    const css = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");

    // The repeated class is what beats .cm-sql-table-name (same specificity as a
    // single class once the generated theme id prefix is accounted for).
    expect(css).toContain(".cm-sql-unknown-object.cm-sql-unknown-object.cm-sql-unknown-object");
    expect(css).toContain("var(--dbx-sql-unknown-object-color, #e5484d) !important");
  });
});
