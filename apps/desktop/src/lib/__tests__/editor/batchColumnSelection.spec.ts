import { describe, expect, it } from "vitest";
import { batchColumnSelectionColumnList, batchColumnSelectionInsertReplacement, batchColumnSelectionReplaceTo, isBatchColumnSelectionCompletionActive, shouldResolveSqlColumnCompletion } from "@/lib/editor/batchColumnSelection";

describe("batchColumnSelectionColumnList", () => {
  it("keeps a typed qualifier on every projection after the first", () => {
    expect(batchColumnSelectionColumnList(["method", "path", "remark"], "select", "ap")).toBe("method, ap.path, ap.remark");
  });

  it("does not add a qualifier to INSERT target columns", () => {
    expect(batchColumnSelectionColumnList(["id", "name"], "insert", "users")).toBe("id, name");
  });
});

describe("batchColumnSelectionReplaceTo", () => {
  it("consumes the auto-inserted INSERT closing parenthesis", () => {
    expect(batchColumnSelectionReplaceTo({ to: 20, mode: "insert", nextCharacter: ")" })).toBe(21);
  });

  it("keeps the replacement boundary when INSERT has no closing parenthesis", () => {
    expect(batchColumnSelectionReplaceTo({ to: 20, mode: "insert", nextCharacter: "" })).toBe(20);
  });

  it("continues consuming a matching closing identifier quote", () => {
    expect(batchColumnSelectionReplaceTo({ to: 20, mode: "select", nextCharacter: '"', replaceClosingQuote: '"' })).toBe(21);
  });
});

describe("batchColumnSelectionInsertReplacement", () => {
  it("consumes whitespace before an existing closing parenthesis", () => {
    expect(
      batchColumnSelectionInsertReplacement({
        document: "INSERT INTO users (id   )",
        to: "INSERT INTO users (id".length,
        columns: "id, name",
        valuesKeyword: "VALUES",
        valueCount: 2,
      }),
    ).toEqual({ replaceTo: "INSERT INTO users (id   )".length, insert: "id, name) VALUES (${1:value}, ${2:value})" });
  });

  it("does not duplicate an existing VALUES clause", () => {
    expect(
      batchColumnSelectionInsertReplacement({
        document: "INSERT INTO users (id)  VALUES (1)",
        to: "INSERT INTO users (id".length,
        columns: "id, name",
        valuesKeyword: "VALUES",
        valueCount: 2,
      }),
    ).toEqual({ replaceTo: "INSERT INTO users (id)".length, insert: "id, name)" });
  });
});

describe("isBatchColumnSelectionCompletionActive", () => {
  it("only accepts a currently active completion popup", () => {
    expect(isBatchColumnSelectionCompletionActive("active")).toBe(true);
    expect(isBatchColumnSelectionCompletionActive("pending")).toBe(false);
    expect(isBatchColumnSelectionCompletionActive(null)).toBe(false);
  });
});

describe("shouldResolveSqlColumnCompletion", () => {
  it("loads fields after SELECT space when a FROM table is already known", () => {
    expect(shouldResolveSqlColumnCompletion({ suggestColumns: true, hasReferencedTables: true, prefix: "", typedActivation: false, selectListColumnContext: true })).toBe(true);
  });

  it("keeps empty non-SELECT column contexts from fetching metadata", () => {
    expect(shouldResolveSqlColumnCompletion({ suggestColumns: true, hasReferencedTables: true, prefix: "", typedActivation: false, selectListColumnContext: false })).toBe(false);
  });
});
