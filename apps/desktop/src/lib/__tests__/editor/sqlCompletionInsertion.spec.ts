import { describe, expect, it } from "vitest";
import { appendSqlCompletionSpace } from "@/lib/editor/sqlCompletionInsertion";

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
