import { describe, expect, it, vi } from "vitest";
import { analyzeSqlDiagnosticReferences } from "@/lib/sql/sqlDiagnosticKeywordRecovery";
import { sqlTextSpanToOffsetRange } from "@/lib/sql/semantic/diagnostics";
import type { SqlReferenceAnalysis, SqlTextSpan } from "@/types/database";

function span(sql: string, text: string): SqlTextSpan {
  const from = sql.indexOf(text);
  const lines = sql.slice(0, from).split("\n");
  return { start_line: lines.length, start_column: lines[lines.length - 1]!.length + 1, end_line: lines.length, end_column: lines[lines.length - 1]!.length + text.length };
}

function parserError(sql: string, text: string) {
  const location = span(sql, text);
  return new Error(`sql parser error: Expected: end of statement, found: ${text} at Line: ${location.start_line}, Column: ${location.start_column}`);
}

const empty: SqlReferenceAnalysis = { tables: [], columns: [] };

describe("SQL diagnostic keyword recovery", () => {
  it.each(["mysql", "postgres", "sqlite", "sqlserver", "oracle", "duckdb", "clickhouse", "generic"])("recovers FROM and preserves following reference positions for %s", async (dialect) => {
    const sql = "SELECT * FRO rules WHERE rule_bod = 1";
    const repaired = sql.replace("FRO", "FROM");
    const error = parserError(sql, "rules");
    const result: SqlReferenceAnalysis = { tables: [{ name: "rules", span: span(repaired, "rules"), scope_id: 1 }], columns: [{ name: "rule_bod", span: span(repaired, "rule_bod"), scope_id: 1 }], scopes: [{ id: 1 }] };
    const analyze = vi.fn(async (statement: string) => {
      if (statement === repaired) return result;
      throw error;
    });
    const recovered = await analyzeSqlDiagnosticReferences(sql, dialect, analyze);
    expect(analyze.mock.calls.map(([statement]) => statement)).toEqual([sql, repaired]);
    expect(recovered.keywordDiagnostic?.message).toContain("FRO → FROM");
    expect(recovered.keywordDiagnostic?.span).toEqual(span(sql, "FRO"));
    expect(recovered.analysis.tables[0]).toEqual({ name: "rules", span: span(sql, "rules"), scope_id: 1 });
    expect(recovered.analysis.columns[0]).toEqual({ name: "rule_bod", span: span(sql, "rule_bod"), scope_id: 1 });
    expect(recovered.analysis.scopes).toBe(result.scopes);
  });

  it.each([
    ["SELEC id FROM users", "SELEC", "SELECT", "SELEC"],
    ["SLECT id FROM users", "SLECT", "SELECT", "SLECT"],
    ["SELECT * FORM users", "FORM", "FROM", "users"],
    ["SELECT * FRROM users", "FRROM", "FROM", "users"],
    ["SELECT * FROM users WHER id = 1", "WHER", "WHERE", "id"],
    ["SELECT * FROM users WEHRE id = 1", "WEHRE", "WHERE", "id"],
    ["UPDTE users SET id = 1", "UPDTE", "UPDATE", "UPDTE"],
    ["INSET INTO users VALUES (1)", "INSET", "INSERT", "INSET"],
    ["SELECT * FROM users ODRER BY id", "ODRER", "ORDER", "BY"],
  ])("handles a verified typo in %s", async (sql, typo, keyword, reportedToken) => {
    const repaired = sql.replace(typo, keyword);
    const analyze = vi.fn(async (statement: string) => {
      if (statement === repaired) return empty;
      throw parserError(sql, reportedToken);
    });
    const recovered = await analyzeSqlDiagnosticReferences(sql, "generic", analyze);
    expect(recovered.keywordDiagnostic?.span).toEqual(span(sql, typo));
  });

  it.each(["SELECT form, fro, wher FROM rules", "SELECT id form FROM users", "SELECT * FROM orderr", "SELECT 'FRO' AS wher", 'SELECT "FRO" FROM users'])('does not reinterpret valid identifiers or aliases in "%s"', async (sql) => {
    const analyze = vi.fn().mockResolvedValue(empty);
    expect(await analyzeSqlDiagnosticReferences(sql, "postgres", analyze)).toEqual({ analysis: empty });
    expect(analyze).toHaveBeenCalledExactlyOnceWith(sql);
  });

  it.each(["SELECT * `FRO` rules", 'SELECT * "FRO" rules', "SELECT * [FRO] rules", "SELECT * 'FRO' rules", "SELECT * /* FRO */ rules"])("does not repair quoted text or comments in %s", async (sql) => {
    const error = parserError(sql, "rules");
    const analyze = vi.fn().mockRejectedValue(error);
    await expect(analyzeSqlDiagnosticReferences(sql, "sqlserver", analyze)).rejects.toBe(error);
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("keeps the original parser error when no candidate parses", async () => {
    const sql = "SELECT * FRO rules WHERE";
    const error = parserError(sql, "rules");
    const analyze = vi.fn().mockRejectedValue(error);
    await expect(analyzeSqlDiagnosticReferences(sql, "mysql", analyze)).rejects.toBe(error);
    expect(analyze.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("does not retry failures without parser locations", async () => {
    const error = new Error("backend unavailable");
    const analyze = vi.fn().mockRejectedValue(error);
    await expect(analyzeSqlDiagnosticReferences("SELECT * FRO rules", "mysql", analyze)).rejects.toBe(error);
    expect(analyze).toHaveBeenCalledOnce();
  });

  it.each(["\n", "\r\n"])("maps same-line and subsequent-line spans independently with %j newlines", async (newline) => {
    const sql = `-- FRO in a comment${newline}SELECT id FRO rules${newline}WHERE rule_bod = 1`;
    const repaired = sql.replace("id FRO", "id FROM");
    const analyze = vi.fn(async (statement: string) => {
      if (statement !== repaired) throw parserError(sql, "rules");
      return {
        tables: [{ name: "rules", span: span(repaired, "rules") }],
        columns: [
          { name: "id", span: span(repaired, "id") },
          { name: "rule_bod", span: span(repaired, "rule_bod") },
        ],
        group_by_violations: [{ column: "rule_bod", span: span(repaired, "rule_bod") }],
      };
    });
    const result = await analyzeSqlDiagnosticReferences(sql, "mysql", analyze);
    expect(result.analysis.tables[0]?.span).toEqual(span(sql, "rules"));
    expect(result.analysis.columns.map((column) => column.span)).toEqual([span(sql, "id"), span(sql, "rule_bod")]);
    expect(result.analysis.group_by_violations?.[0]?.span).toEqual(span(sql, "rule_bod"));
    const range = sqlTextSpanToOffsetRange(sql, result.keywordDiagnostic!.span)!;
    expect(sql.slice(range.from, range.to)).toBe("FRO");
  });
});
