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

  it("selects the text inside square brackets and curly braces from either end and side", () => {
    const arrayDoc = "select array[a + b] from t";
    const sqOpen = arrayDoc.indexOf("[");
    const sqClose = arrayDoc.indexOf("]");
    expect(contentAt(arrayDoc, sqOpen, 1)).toBe("a + b");
    expect(contentAt(arrayDoc, sqOpen + 1, -1)).toBe("a + b");
    expect(contentAt(arrayDoc, sqClose, 1)).toBe("a + b");
    expect(contentAt(arrayDoc, sqClose + 1, -1)).toBe("a + b");

    const objectDoc = "select object{a: 1} from t";
    const braceOpen = objectDoc.indexOf("{");
    const braceClose = objectDoc.indexOf("}");
    expect(contentAt(objectDoc, braceOpen, 1)).toBe("a: 1");
    expect(contentAt(objectDoc, braceOpen + 1, -1)).toBe("a: 1");
    expect(contentAt(objectDoc, braceClose, 1)).toBe("a: 1");
    expect(contentAt(objectDoc, braceClose + 1, -1)).toBe("a: 1");
  });

  it("pairs nested square brackets, curly braces, and mixed bracket types on their own level", () => {
    const nestedBrackets = "a[[b], [c]] + [d]";
    expect(contentAt(nestedBrackets, nestedBrackets.indexOf("[[b"), 1)).toBe("[b], [c]");
    expect(contentAt(nestedBrackets, nestedBrackets.indexOf("[b"), 1)).toBe("b");
    expect(contentAt(nestedBrackets, nestedBrackets.indexOf("[c"), 1)).toBe("c");
    expect(contentAt(nestedBrackets, nestedBrackets.indexOf("[d"), 1)).toBe("d");

    const nestedBraces = "a{{b}, {c}} + {d}";
    expect(contentAt(nestedBraces, nestedBraces.indexOf("{{b"), 1)).toBe("{b}, {c}");
    expect(contentAt(nestedBraces, nestedBraces.indexOf("{b"), 1)).toBe("b");
    expect(contentAt(nestedBraces, nestedBraces.indexOf("{c"), 1)).toBe("c");
    expect(contentAt(nestedBraces, nestedBraces.indexOf("{d"), 1)).toBe("d");

    const mixed = "fn(array[obj{a: (1 + 2)}])";
    expect(contentAt(mixed, mixed.indexOf("(array"), 1)).toBe("array[obj{a: (1 + 2)}]");
    expect(contentAt(mixed, mixed.indexOf("[obj"), 1)).toBe("obj{a: (1 + 2)}");
    expect(contentAt(mixed, mixed.indexOf("{a:"), 1)).toBe("a: (1 + 2)");
    expect(contentAt(mixed, mixed.indexOf("(1 + 2"), 1)).toBe("1 + 2");
    expect(contentAt(mixed, mixed.indexOf("}"), 1)).toBe("a: (1 + 2)");
    expect(contentAt(mixed, mixed.indexOf("]"), 1)).toBe("obj{a: (1 + 2)}");
  });

  it("spans lines for square brackets and curly braces", () => {
    const multiArray = "select array[\n  a + b\n]";
    expect(contentAt(multiArray, multiArray.indexOf("["), 1)).toBe("\n  a + b\n");
    expect(contentAt(multiArray, multiArray.indexOf("]"), 1)).toBe("\n  a + b\n");

    const multiObject = "select object{\n  a: 1\n}";
    expect(contentAt(multiObject, multiObject.indexOf("{"), 1)).toBe("\n  a: 1\n");
    expect(contentAt(multiObject, multiObject.indexOf("}"), 1)).toBe("\n  a: 1\n");
  });

  it("ignores square brackets and curly braces inside strings, quoted identifiers and comments", () => {
    const tricky = "select array['[', a], object{'{', b}, \"c]\", \"d}\" /* ] } */ from t -- [ {\nwhere [x] and {y}";
    expect(contentAt(tricky, tricky.indexOf("array[") + "array".length, 1)).toBe("'[', a");
    expect(contentAt(tricky, tricky.indexOf("a]") + 1, 1)).toBe("'[', a");
    expect(contentAt(tricky, tricky.indexOf("object{") + "object".length, 1)).toBe("'{', b");
    expect(contentAt(tricky, tricky.indexOf("b}") + 1, 1)).toBe("'{', b");
    expect(contentAt(tricky, tricky.indexOf("'['") + 1, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("'{'") + 1, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("c]") + 1, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("d}") + 1, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("/* ]") + 3, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("} */"), 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("-- [") + 3, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("[ {\n") + 2, 1)).toBeNull();
    expect(contentAt(tricky, tricky.indexOf("[x"), 1)).toBe("x");
    expect(contentAt(tricky, tricky.indexOf("{y"), 1)).toBe("y");

    const oracleQ = "select q'[a + b]', q'{c: 1}' from dual";
    expect(contentAt(oracleQ, oracleQ.indexOf("["), 1, { databaseType: "oracle" })).toBeNull();
    expect(contentAt(oracleQ, oracleQ.indexOf("{"), 1, { databaseType: "oracle" })).toBeNull();

    const dollarQuoted = "select $$[a + b] {c: 1}$$";
    expect(contentAt(dollarQuoted, dollarQuoted.indexOf("["), 1, { dialect: "postgres" })).toBeNull();
    expect(contentAt(dollarQuoted, dollarQuoted.indexOf("{"), 1, { dialect: "postgres" })).toBeNull();
  });

  it("handles SQL Server and SQLite bracket-quoted identifiers without breaking parenthesis pairing", () => {
    const sqlServerDoc = "select ([a)b]), [Order Details], object{a: 1} from [dbo].[Orders]";
    expect(contentAt(sqlServerDoc, sqlServerDoc.indexOf("("), 1, { databaseType: "sqlserver" })).toBe("[a)b]");
    expect(contentAt(sqlServerDoc, sqlServerDoc.indexOf("[Order"), 1, { databaseType: "sqlserver" })).toBe("Order Details");
    expect(contentAt(sqlServerDoc, sqlServerDoc.indexOf("Details]") + "Details".length, 1, { databaseType: "sqlserver" })).toBe("Order Details");
    expect(contentAt(sqlServerDoc, sqlServerDoc.indexOf("{"), 1, { databaseType: "sqlserver" })).toBe("a: 1");
    expect(contentAt("select []", "select ".length, 1, { databaseType: "sqlserver" })).toBeNull();
    expect(contentAt("select [Order", "select ".length, 1, { databaseType: "sqlserver" })).toBeNull();
    expect(contentAt("select [col]", "select ".length, 1, { databaseType: "sqlite" })).toBe("col");
  });

  it("falls back for empty, unmatched, or crossed square brackets and curly braces", () => {
    expect(contentAt("select []", "select ".length)).toBeNull();
    expect(contentAt("select {}", "select ".length)).toBeNull();
    expect(contentAt("select [a + b", "select ".length)).toBeNull();
    expect(contentAt("select a + b]", "select a + b".length)).toBeNull();
    expect(contentAt("select {a: 1", "select ".length)).toBeNull();
    expect(contentAt("select a: 1}", "select a: 1".length)).toBeNull();
    expect(contentAt("[1]", 0, -1)).toBeNull();
    expect(contentAt("{1}", 0, -1)).toBeNull();
    expect(contentAt("select ([1)", "select ".length)).toBeNull();
  });

  it("does not let an unmatched bracket in an earlier statement break later pairs", () => {
    const script = "select [1;\nselect {2;\nselect (3;\nselect [a + b], {c: 1}, (d) from t";
    expect(contentAt(script, script.indexOf("[a + b"), 1)).toBe("a + b");
    expect(contentAt(script, script.indexOf("{c: 1"), 1)).toBe("c: 1");
    expect(contentAt(script, script.indexOf("(d"), 1)).toBe("d");
  });
});

describe("createQueryEditorParenthesisMouseSelection", () => {
  const doc = "select * from t where id in (1, 2) and arr = array[a + b] and obj = object{a: 1}";
  const state = EditorState.create({ doc });
  const open = doc.indexOf("(1");
  const squareOpen = doc.indexOf("[a");
  const curlyOpen = doc.indexOf("{a");

  it("selects the content between parentheses, square brackets, or curly braces on a double click", () => {
    for (const [pos, expected] of [
      [open, "1, 2"],
      [squareOpen, "a + b"],
      [curlyOpen, "a: 1"],
    ] as const) {
      const style = createQueryEditorParenthesisMouseSelection(fakeView(state), eventAt(pos));
      expect(style).not.toBeNull();
      const selection = style!.get(eventAt(pos), false, false);
      expect(doc.slice(selection.main.from, selection.main.to)).toBe(expected);
    }
  });

  it("adds to the selection with a multi-cursor click and extends it with shift", () => {
    const base = EditorState.create({ doc, selection: EditorSelection.cursor(0) });
    const style = createQueryEditorParenthesisMouseSelection(fakeView(base), eventAt(open))!;
    const added = style.get(eventAt(open), false, true);
    expect(added.ranges.map((range) => doc.slice(range.from, range.to))).toEqual(["", "1, 2"]);
    const extended = style.get(eventAt(open), true, false);
    expect(doc.slice(extended.main.from, extended.main.to)).toBe(doc.slice(0, doc.indexOf("2)") + 1));

    const squareStyle = createQueryEditorParenthesisMouseSelection(fakeView(base), eventAt(squareOpen))!;
    const squareAdded = squareStyle.get(eventAt(squareOpen), false, true);
    expect(squareAdded.ranges.map((range) => doc.slice(range.from, range.to))).toEqual(["", "a + b"]);
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
    expect(createQueryEditorParenthesisMouseSelection(view, eventAt(squareOpen), { language: "text" })).toBeNull();
    expect(createQueryEditorParenthesisMouseSelection(view, eventAt(curlyOpen), { language: "text" })).toBeNull();
  });
});
