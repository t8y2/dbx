import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { getSqlCompletionContext } from "@/lib/sql/sqlCompletion";
import { SqlCompletionAnalysisEngine } from "@/lib/sql/sqlCompletionAnalysis";

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

describe("SQL completion with long string literals", () => {
  it.each(["before semicolon", "after semicolon", "inside literal"] as const)("keeps completion responsive %s", (position) => {
    const hex = "3c3f786d6c".repeat(20_000);
    const document = `UPDATE app.documents\nSET data = decode('${hex}', 'hex')\nWHERE id = 1\nRETURNING name;`;
    const cursor = position === "before semicolon" ? document.length - 1 : position === "after semicolon" ? document.length : document.indexOf(hex) + hex.length / 2;
    const engine = new SqlCompletionAnalysisEngine();
    const start = performance.now();
    const result = engine.analyze({ sql: document, cursor, databaseType: "postgres", dialect: "postgres", semanticCompletionEnabled: true });
    const elapsed = performance.now() - start;

    expect(result.suppressed).toBe(position === "inside literal");
    if (position !== "inside literal") {
      expect(result.completionContext.prefix).toBe(position === "before semicolon" ? "name" : "");
    }
    // Leave ample CI headroom while catching quadratic scans over the 200 KB literal.
    expect(elapsed).toBeLessThan(1_000);
  });

  it.each([
    { sql: "SELECT 中文_name", databaseType: "postgres" as const, prefix: "中文_name" },
    { sql: "SELECT 𐐀name", databaseType: "postgres" as const, prefix: "𐐀name" },
    { sql: "SELECT @customer_", databaseType: "sqlserver" as const, prefix: "@customer_" },
    { sql: "SELECT t.customer_", databaseType: "postgres" as const, prefix: "customer_", qualifier: "t" },
    { sql: 'SELECT "Mixed.Schema"."Name"', databaseType: "postgres" as const, prefix: "Name", qualifier: "Mixed.Schema" },
    { sql: "SELECT `column_name`", databaseType: "mysql" as const, prefix: "column_name" },
  ])("preserves the identifier suffix in $sql", ({ sql: document, databaseType, prefix, qualifier }) => {
    const context = getSqlCompletionContext(document, document.length, { databaseType });
    expect(context.prefix).toBe(prefix);
    expect(context.qualifier).toBe(qualifier);
  });
});
