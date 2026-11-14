import { describe, expect, it } from "vitest";
import { appendUniqueSqlSemanticDiagnostics, sqlSyntaxDiagnosticToSemantic, sqlTextSpanToOffsetRange } from "@/lib/sql/semantic/diagnostics";
import type { SqlSemanticDiagnostic } from "@/lib/sql/semantic/diagnostics";
import type { SqlSyntaxDiagnostic } from "@/types/database";

const diagnostic: SqlSyntaxDiagnostic = {
  message: "Expected: an expression, found: AND",
  severity: "error",
  span: { start_line: 1, start_column: 8, end_line: 1, end_column: 10 },
  expected: ["an expression"],
  found: "AND",
};

describe("structured SQL syntax diagnostics", () => {
  it("keeps the parser's structured message, severity and range", () => {
    const mapped = sqlSyntaxDiagnosticToSemantic(diagnostic, "SELECT active AND");
    expect(mapped).toEqual({ message: diagnostic.message, severity: "error", span: diagnostic.span });
    expect(sqlTextSpanToOffsetRange("SELECT active AND", mapped.span)).toEqual({ from: 7, to: 10 });
  });

  it("maps an invalid zero-length EOF span to the last visible character", () => {
    const sql = "SELECT * FROM users WHERE id =";
    const eof: SqlSyntaxDiagnostic = {
      message: "Expected: an expression",
      severity: "error",
      span: { start_line: 1, start_column: sql.length + 1, end_line: 1, end_column: sql.length + 1 },
    };
    const mapped = sqlSyntaxDiagnosticToSemantic(eof, sql);
    const range = sqlTextSpanToOffsetRange(sql, mapped.span);
    expect(range).not.toBeNull();
    expect(range!.to).toBeGreaterThan(range!.from);
    expect(range!.to).toBe(sql.length);
  });

  it("deduplicates only the same diagnostic at the same range", () => {
    const target: SqlSemanticDiagnostic[] = [];
    appendUniqueSqlSemanticDiagnostics(target, [sqlSyntaxDiagnosticToSemantic(diagnostic)]);
    appendUniqueSqlSemanticDiagnostics(target, [sqlSyntaxDiagnosticToSemantic(diagnostic)]);
    expect(target).toHaveLength(1);
    appendUniqueSqlSemanticDiagnostics(target, [{ ...target[0], message: "Another error" }]);
    expect(target).toHaveLength(2);
  });
});
