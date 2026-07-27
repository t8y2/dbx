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
    expect(appendSqlCompletionSpace("orders", { enabled: true, itemType: "table", nextCharacter: ")" })).toBe("orders");
    expect(appendSqlCompletionSpace("orders", { enabled: true, itemType: "table", nextCharacter: "," })).toBe("orders");
  });

  it("honors the setting and leaves snippet-like completions unchanged", () => {
    expect(appendSqlCompletionSpace("SELECT", { enabled: false, itemType: "keyword" })).toBe("SELECT");
    expect(appendSqlCompletionSpace("CASE ${value}", { enabled: true, itemType: "snippet" })).toBe("CASE ${value}");
    expect(appendSqlCompletionSpace("count()", { enabled: true, itemType: "function" })).toBe("count()");
  });
});
