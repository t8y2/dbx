import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createQueryEditorStringMouseSelection } from "@/lib/editor/queryEditorStringMouseSelection";
import { sqlStringContentRangeAt, type SqlSemanticSelectionOptions } from "@/lib/editor/sqlSemanticSelectionRanges";

function eventAt(position: number, assoc: -1 | 1 = 1, overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    altKey: false,
    button: 0,
    clientX: position,
    clientY: assoc,
    detail: 2,
    ...overrides,
  } as MouseEvent;
}

function fakeView(initialState: EditorState): { view: EditorView; setState: (state: EditorState) => void } {
  let state = initialState;
  return {
    view: {
      get state() {
        return state;
      },
      posAndSideAtCoords(coords: { x: number; y: number }) {
        return { pos: coords.x, assoc: coords.y < 0 ? -1 : 1 };
      },
    } as EditorView,
    setState(nextState) {
      state = nextState;
    },
  };
}

function contentAt(doc: string, position: number, assoc: -1 | 1 = 1, options: SqlSemanticSelectionOptions = {}): string | null {
  const range = sqlStringContentRangeAt(doc, position, assoc, options);
  return range ? doc.slice(range.from, range.to) : null;
}

describe("query editor SQL string mouse selection", () => {
  it("finds the complete reported literal from its first, middle, and last segment", () => {
    const content = "2026-ads-1TH0G6A0gnI6EFujlZ3pMQ18";
    const doc = `select '${content}'`;
    const from = doc.indexOf(content);

    expect(contentAt(doc, from, 1)).toBe(content);
    expect(contentAt(doc, from + content.indexOf("ads") + 1)).toBe(content);
    expect(contentAt(doc, from + content.length, -1)).toBe(content);
  });

  it("supports punctuation, whitespace, CJK, emoji, escaped quotes, and PostgreSQL dollar quotes", () => {
    const cases: Array<{ doc: string; needle: string; expected: string; options?: SqlSemanticSelectionOptions }> = [
      { doc: "select 'a.b / c'", needle: "/", expected: "a.b / c" },
      { doc: "select '中文🙂内容'", needle: "🙂", expected: "中文🙂内容" },
      { doc: "select 'O''Reilly'", needle: "Reilly", expected: "O''Reilly" },
      { doc: "select $tag$a-b 中文$tag$", needle: "中文", expected: "a-b 中文", options: { dialect: "postgres" } },
    ];

    for (const value of cases) expect(contentAt(value.doc, value.doc.indexOf(value.needle), 1, value.options)).toBe(value.expected);
  });

  it("falls back for delimiters, empty or incomplete strings, and non-string SQL tokens", () => {
    const doc = "select 'value', \"identifier\", 123 /* 'comment' */ + 1";
    const opening = doc.indexOf("'value'");
    const closing = opening + "'value'".length - 1;

    expect(contentAt(doc, opening)).toBeNull();
    expect(contentAt(doc, closing)).toBeNull();
    expect(contentAt("select ''", "select '".length)).toBeNull();
    expect(contentAt("select 'unfinished", "select 'unfinished".length, -1)).toBeNull();
    expect(contentAt("select '''", "select ''".length, -1)).toBeNull();
    for (const needle of ["identifier", "123", "comment", "+"]) expect(contentAt(doc, doc.indexOf(needle))).toBeNull();
  });

  it("only overrides an unmodified left-button SQL double click", () => {
    const doc = "select 'alpha-beta'";
    const state = EditorState.create({ doc });
    const { view } = fakeView(state);
    const position = doc.indexOf("alpha");

    expect(createQueryEditorStringMouseSelection(view, eventAt(position))).not.toBeNull();
    expect(createQueryEditorStringMouseSelection(view, eventAt(position, 1, { button: 1 }))).toBeNull();
    expect(createQueryEditorStringMouseSelection(view, eventAt(position, 1, { detail: 1 }))).toBeNull();
    expect(createQueryEditorStringMouseSelection(view, eventAt(position, 1, { detail: 3 }))).toBeNull();
    expect(createQueryEditorStringMouseSelection(view, eventAt(position, 1, { altKey: true }))).toBeNull();
    expect(createQueryEditorStringMouseSelection(view, eventAt(position), { composing: true })).toBeNull();
    expect(createQueryEditorStringMouseSelection(view, eventAt(position), { language: "text" })).toBeNull();
    expect(createQueryEditorStringMouseSelection(view, eventAt(doc.indexOf("'")))).toBeNull();
  });

  it("selects string content in editable and read-only states", () => {
    const doc = "select 'alpha-beta'";
    for (const readOnly of [false, true]) {
      const state = EditorState.create({ doc, extensions: [EditorState.readOnly.of(readOnly)] });
      const { view } = fakeView(state);
      const start = eventAt(doc.indexOf("alpha"));
      const style = createQueryEditorStringMouseSelection(view, start);

      expect(style).not.toBeNull();
      const selection = style?.get(start, false, false);
      expect(selection && doc.slice(selection.main.from, selection.main.to)).toBe("alpha-beta");
    }
  });

  it("preserves Shift extension and Mod-added ranges with the original main index", () => {
    const doc = "z select 'alpha-beta' tail";
    const initialSelection = EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(doc.length)], 0);
    const state = EditorState.create({ doc, selection: initialSelection, extensions: [EditorState.allowMultipleSelections.of(true)] });
    const start = eventAt(doc.indexOf("alpha"));

    const shiftStyle = createQueryEditorStringMouseSelection(fakeView(state).view, start);
    const extended = shiftStyle?.get(start, true, false);
    expect(extended?.ranges).toHaveLength(2);
    expect(extended?.mainIndex).toBe(0);
    expect(extended?.main.anchor).toBe(0);
    expect(extended?.main.to).toBe(doc.indexOf("' tail"));

    const modStyle = createQueryEditorStringMouseSelection(fakeView(state).view, start);
    const added = modStyle?.get(start, false, true);
    expect(added?.ranges).toHaveLength(3);
    expect(added?.ranges.map((range) => doc.slice(range.from, range.to))).toContain("alpha-beta");
  });

  it("extends a double-click drag by semantic string groups in both directions", () => {
    const doc = "'alpha-beta' + 'gamma-delta'";
    const state = EditorState.create({ doc });
    const alpha = eventAt(doc.indexOf("alpha"));
    const gamma = eventAt(doc.indexOf("gamma"));

    const forward = createQueryEditorStringMouseSelection(fakeView(state).view, alpha)?.get(gamma, false, false).main;
    expect(forward && doc.slice(forward.from, forward.to)).toBe("alpha-beta' + 'gamma-delta");
    expect(forward?.anchor).toBeLessThan(forward?.head ?? 0);

    const reverse = createQueryEditorStringMouseSelection(fakeView(state).view, gamma)?.get(alpha, false, false).main;
    expect(reverse && doc.slice(reverse.from, reverse.to)).toBe("alpha-beta' + 'gamma-delta");
    expect(reverse?.anchor).toBeGreaterThan(reverse?.head ?? Number.POSITIVE_INFINITY);
  });

  it("maps the start selection and semantic analysis across document changes", () => {
    const doc = "select 'alpha-beta'";
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) });
    const fixture = fakeView(state);
    const start = eventAt(doc.indexOf("alpha"));
    const style = createQueryEditorStringMouseSelection(fixture.view, start);
    const transaction = state.update({ changes: { from: 0, insert: "-- " } });
    fixture.setState(transaction.state);
    style?.update({ docChanged: true, changes: transaction.changes, startState: state, state: transaction.state, view: fixture.view } as ViewUpdate);

    const selection = style?.get(eventAt(doc.indexOf("alpha") + 3), false, false);
    expect(selection && transaction.state.sliceDoc(selection.main.from, selection.main.to)).toBe("alpha-beta");
  });
});
