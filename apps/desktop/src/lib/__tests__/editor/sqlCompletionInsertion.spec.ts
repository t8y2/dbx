import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { additionalSnippetApplyTargets, appendSqlCompletionSpace } from "@/lib/editor/sqlCompletionInsertion";

describe("SQL completion insertion", () => {
  it("appends a space to ordinary completions by default", () => {
    expect(appendSqlCompletionSpace("SELECT", { enabled: true, itemType: "keyword" })).toBe("SELECT ");
    expect(appendSqlCompletionSpace("orders AS o", { enabled: true, itemType: "table" })).toBe("orders AS o ");
  });

  it("does not add duplicate or invalid spaces", () => {
    expect(appendSqlCompletionSpace("SELECT ", { enabled: true, itemType: "keyword" })).toBe("SELECT ");
    expect(appendSqlCompletionSpace("public.", { enabled: true, itemType: "schema" })).toBe("public.");
    expect(appendSqlCompletionSpace("name", { enabled: true, itemType: "property" })).toBe("name");
    expect(appendSqlCompletionSpace("key", { enabled: true, itemType: "text" })).toBe("key");
    expect(appendSqlCompletionSpace("tt", { enabled: true, itemType: "variable" })).toBe("tt");
    expect(appendSqlCompletionSpace("orders", { enabled: true, itemType: "table", nextCharacter: ")" })).toBe("orders");
    expect(appendSqlCompletionSpace("orders", { enabled: true, itemType: "table", nextCharacter: "," })).toBe("orders");
    expect(appendSqlCompletionSpace("SELECT", { enabled: true, itemType: "keyword", nextCharacter: " " })).toBe("SELECT");
    expect(appendSqlCompletionSpace("SELECT", { enabled: true, itemType: "keyword", nextCharacter: "\t" })).toBe("SELECT");
  });

  it("keeps the space when a statement terminator follows the cursor", () => {
    // Completing `BETWEEN` before an existing `;` must not glue the two together,
    // otherwise the user cannot keep typing the operand without fixing the text.
    expect(appendSqlCompletionSpace("BETWEEN", { enabled: true, itemType: "keyword", nextCharacter: ";" })).toBe("BETWEEN ");
    expect(appendSqlCompletionSpace("SALARY", { enabled: true, itemType: "column", nextCharacter: ";" })).toBe("SALARY ");
  });

  it("appends a space at end of doc, before a newline, and in multi-statement documents", () => {
    expect(appendSqlCompletionSpace("SELECT", { enabled: true, itemType: "keyword", nextCharacter: "" })).toBe("SELECT ");
    expect(appendSqlCompletionSpace("SELECT", { enabled: true, itemType: "keyword", nextCharacter: "\n" })).toBe("SELECT ");
    expect(appendSqlCompletionSpace("SELECT", { enabled: true, itemType: "keyword", nextCharacter: "\r" })).toBe("SELECT ");
    expect(appendSqlCompletionSpace("orders", { enabled: true, itemType: "table", nextCharacter: "\n" })).toBe("orders ");
  });

  it("honors the setting and leaves snippet-like completions unchanged", () => {
    expect(appendSqlCompletionSpace("SELECT", { enabled: false, itemType: "keyword" })).toBe("SELECT");
    expect(appendSqlCompletionSpace("CASE ${value}", { enabled: true, itemType: "snippet" })).toBe("CASE ${value}");
    expect(appendSqlCompletionSpace("count()", { enabled: true, itemType: "function" })).toBe("count()");
  });
});

describe("multi-cursor snippet insertion", () => {
  function stateWithCursors(lines: string[], prefixLength: number, mainIndex = 0) {
    const doc = lines.join("\n");
    const cursors: number[] = [];
    let offset = 0;
    for (const line of lines) {
      cursors.push(offset + prefixLength);
      offset += line.length + 1;
    }
    return EditorState.create({
      doc,
      selection: EditorSelection.create(
        cursors.map((position) => EditorSelection.cursor(position)),
        mainIndex,
      ),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
  }

  it("expands the snippet on every cursor that still carries the trigger prefix", () => {
    const state = stateWithCursors(["sfhd_dwd.a", "sfhd_dwd.b", "sfhd_dwd.c"], 2);

    expect(additionalSnippetApplyTargets(state, 0, 2)).toEqual([
      { from: 22, to: 24 },
      { from: 11, to: 13 },
    ]);
  });

  it("returns nothing for a single cursor", () => {
    const state = stateWithCursors(["sfhd_dwd.a"], 2);

    expect(additionalSnippetApplyTargets(state, 0, 2)).toEqual([]);
  });

  it("skips cursors whose preceding text is not the typed prefix", () => {
    const doc = "sfhd_dwd.a\nxxhd_dwd.b\nSFhd_dwd.c";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(doc.indexOf("xx") + 2), EditorSelection.cursor(doc.indexOf("SF") + 2)], 0),
      extensions: EditorState.allowMultipleSelections.of(true),
    });

    expect(additionalSnippetApplyTargets(state, 0, 2)).toEqual([]);
  });

  it("orders targets backwards even when the main cursor is in the middle", () => {
    const state = stateWithCursors(["sfhd_dwd.a", "sfhd_dwd.b", "sfhd_dwd.c"], 2, 1);

    expect(additionalSnippetApplyTargets(state, state.selection.ranges[1].from - 2, state.selection.ranges[1].from)).toEqual([
      { from: 22, to: 24 },
      { from: 0, to: 2 },
    ]);
  });
});
