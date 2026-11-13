import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createQueryEditorParenthesisMouseSelection, sqlParenthesisContentRangeAt } from "@/lib/editor/queryEditorParenthesisMouseSelection";
import type { SqlSemanticSelectionOptions } from "@/lib/editor/sqlSemanticSelectionRanges";

function eventAt(position: number, assoc: -1 | 1 = 1, overrides: Partial<MouseEvent> = {}): MouseEvent {
  return { altKey: false, button: 0, clientX: position, clientY: assoc, detail: 2, ...overrides } as MouseEvent;
}

function fakeView(state: EditorState): EditorView {
  return {
    state,
    posAndSideAtCoords(coords: { x: number; y: number }) {
      return { pos: coords.x, assoc: coords.y < 0 ? -1 : 1 };
    },
  } as unknown as EditorView;
}

function contentAt(doc: string, position: number, assoc: -1 | 1 = 1, options: SqlSemanticSelectionOptions = {}): string | null {
  const range = sqlParenthesisContentRangeAt(doc, position, assoc, options);
  return range ? doc.slice(range.from, range.to) : null;
}

describe("sqlParenthesisContentRangeAt", () => {
  const doc = "select * from t where id in (select id from u where x in (1, 2)) and y = 3";
  const outerOpen = doc.indexOf("(select");
  const outerClose = doc.indexOf("2)) and") + 2;
  const innerOpen = doc.indexOf("(1,");
  const innerClose = doc.indexOf("2)") + 1;

  it("selects the text between a parenthesis and its partner from either end", () => {
    const outer = "select id from u where x in (1, 2)";
    const inner = "1, 2";
    expect(contentAt(doc, outerOpen, 1)).toBe(outer);
    expect(contentAt(doc, outerClose, 1)).toBe(outer);
    expect(contentAt(doc, innerOpen, 1)).toBe(inner);
    expect(contentAt(doc, innerClose, 1)).toBe(inner);
  });

  it("uses the character the pointer hit, whichever side of the boundary it landed on", () => {
    const inner = "1, 2";
    // Left half of "(" resolves to the boundary before it, right half to the one after it.
    expect(contentAt(doc, innerOpen, 1)).toBe(inner);
    expect(contentAt(doc, innerOpen + 1, -1)).toBe(inner);
    expect(contentAt(doc, innerClose, 1)).toBe(inner);
    expect(contentAt(doc, innerClose + 1, -1)).toBe(inner);
  });

  it("pairs nested parentheses on their own level", () => {
    const nested = "a((b), (c)) + (d)";
    expect(contentAt(nested, nested.indexOf("((b"), 1)).toBe("(b), (c)");
    expect(contentAt(nested, nested.indexOf("(b"), 1)).toBe("b");
    expect(contentAt(nested, nested.indexOf("(c"), 1)).toBe("c");
    expect(contentAt(nested, nested.indexOf("(d"), 1)).toBe("d");
  });

  it("spans lines", () => {
    const multi = "with t as (\n  select 1\n)\nselect * from t";
    expect(contentAt(multi, multi.indexOf("(\n"), 1)).toBe("\n  select 1\n");
    expect(contentAt(multi, multi.indexOf("\n)") + 1, 1)).toBe("\n  select 1\n");
  });

  it("ignores parentheses inside strings, quoted identifiers and comments", () => {
    const tricky = "select concat('(', a), \"b)\" /* ) */ from t -- (\nwhere (x)";
    // The code parentheses pair with each other, skipping the "(" inside the string.
    expect(contentAt(tricky, tricky.indexOf("concat(") + "concat".length, 1)).toBe("'(', a");
    expect(contentAt(tricky, tricky.indexOf("a)") + 1, 1)).toBe("'(', a");
    // Parenthesis characters inside the string, the quoted identifier and the comments are not parentheses.
    expect(contentAt(tricky, tricky.indexOf("'('") + 1, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("b)"), 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("b)") + 1, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("/* )") + 3, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("-- (") + 3, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("(x"), 1)).toBe("x");
  });

  it("falls back for other characters, empty pairs and unmatched parentheses", () => {
    expect(contentAt("select a, b from t", 8)).toBeNull();
    expect(contentAt("select now()", "select now".length)).toBeNull();
    expect(contentAt("select (1", "select ".length)).toBeNull();
    expect(contentAt("select 1)", "select 1".length)).toBeNull();
    expect(contentAt("(1)", 0, -1)).toBeNull();
  });

  it("does not let an unmatched parenthesis in an earlier statement break a later pair", () => {
    const script = "select (1;\nselect (a) from t";
    expect(contentAt(script, script.indexOf("(a"), 1)).toBe("a");
  });
});

describe("createQueryEditorParenthesisMouseSelection", () => {
  const doc = "select * from t where id in (1, 2) and y = 3";
  const state = EditorState.create({ doc });
  const open = doc.indexOf("(1");

  it("selects the content between the parentheses on a double click", () => {
    const style = createQueryEditorParenthesisMouseSelection(fakeView(state), eventAt(open));
    expect(style).not.toBeNull();
    const selection = style!.get(eventAt(open), false, false);
    expect(doc.slice(selection.main.from, selection.main.to)).toBe("1, 2");
  });

  it("adds to the selection with a multi-cursor click and extends it with shift", () => {
    const base = EditorState.create({ doc, selection: EditorSelection.cursor(0) });
    const style = createQueryEditorParenthesisMouseSelection(fakeView(base), eventAt(open))!;
    const added = style.get(eventAt(open), false, true);
    expect(added.ranges.map((range) => doc.slice(range.from, range.to))).toEqual(["", "1, 2"]);
    const extended = style.get(eventAt(open), true, false);
    expect(doc.slice(extended.main.from, extended.main.to)).toBe(doc.slice(0, doc.indexOf("2)") + 1));
  });

  it("keeps the default double click for everything else", () => {
    const view = fakeView(state);
    expect(createQueryEditorParenthesisMouseSelection(view, eventAt(doc.indexOf("where")))).toBeNull();
    expect(createQueryEditorParenthesisMouseSelection(view, eventAt(open, 1, { detail: 1 }))).toBeNull();
    expect(createQueryEditorParenthesisMouseSelection(view, eventAt(open, 1, { detail: 3 }))).toBeNull();
    expect(createQueryEditorParenthesisMouseSelection(view, eventAt(open, 1, { button: 2 }))).toBeNull();
    expect(createQueryEditorParenthesisMouseSelection(view, eventAt(open, 1, { altKey: true }))).toBeNull();
    expect(createQueryEditorParenthesisMouseSelection(view, eventAt(open), { composing: true })).toBeNull();
    expect(createQueryEditorParenthesisMouseSelection(view, eventAt(open), { language: "text" })).toBeNull();
  });
});
