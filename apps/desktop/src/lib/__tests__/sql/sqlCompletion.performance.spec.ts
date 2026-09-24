import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { getSqlCompletionContext } from "@/lib/sql/sqlCompletion";

describe("SQL completion statement-local scanning", () => {
  it.each(["\n", " "])("does not split unrelated statements separated by %j before the active syntax-tree window", (separator) => {
    const prefix = `SELECT id FROM previous_table;${separator}`.repeat(2_000);
    const activeStatement = "SELECT customer_ FROM current_table";
    const suffix = ";\n" + "SELECT id FROM later_table;\n".repeat(2_000);
    const document = prefix + activeStatement + suffix;
    const cursor = prefix.length + activeStatement.indexOf(" FROM");
    const state = EditorState.create({ doc: document, extensions: [sql({ dialect: PostgreSQL })] });
    ensureSyntaxTree(state, document.length, 5_000);
    const scannedLengths: number[] = [];
    const originalSplit = String.prototype.split;
    const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (this: string, separator, limit) {
      if (separator instanceof RegExp && separator.source === "\\r?\\n") scannedLengths.push(this.length);
      return originalSplit.call(this, separator, limit);
    });

    try {
      const context = getSqlCompletionContext(document, cursor, { databaseType: "postgres", editorState: state });
      expect(context.referencedTables.map((table) => table.name)).toEqual(["current_table"]);
      expect(scannedLengths.length).toBeGreaterThan(0);
      expect(Math.max(...scannedLengths)).toBeLessThanOrEqual(activeStatement.length);
    } finally {
      splitSpy.mockRestore();
    }
  });

  it("preserves CRLF offsets when selecting a semicolon-free statement block", () => {
    const document = "SELECT id FROM previous_table;\r\nSELECT id FROM first_table\r\nSELECT customer_ FROM current_table\r\nSELECT id FROM later_table";
    const cursor = document.indexOf("customer_") + "customer_".length;
    const state = EditorState.create({ doc: document, extensions: [sql({ dialect: PostgreSQL })] });
    ensureSyntaxTree(state, document.length, 5_000);

    const context = getSqlCompletionContext(document, cursor, { databaseType: "postgres", editorState: state });
    expect(context.prefix).toBe("customer_");
    expect(context.referencedTables.map((table) => table.name)).toEqual(["current_table"]);
  });
});
