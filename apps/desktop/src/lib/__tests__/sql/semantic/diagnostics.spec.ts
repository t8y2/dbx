import { describe, expect, it } from "vitest";
import { buildSqlSemanticDiagnostics } from "@/lib/sql/semantic/diagnostics";
import type { SqlReferenceAnalysis } from "@/types/database";

const span = (startColumn: number, endColumn: number) => ({
  start_line: 1,
  start_column: startColumn,
  end_line: 1,
  end_column: endColumn,
});

describe("buildSqlSemanticDiagnostics GROUP BY violations", () => {
  it("maps analyzer GROUP BY violations to error diagnostics", () => {
    const sql = "SELECT USER_ID, SUM(MONEY) FROM users GROUP BY USER_NAME";
    const analysis: SqlReferenceAnalysis = {
      tables: [],
      columns: [],
      group_by_violations: [{ span: span(8, 15), column: "USER_ID", qualifier: null }],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, { tables: [], columnsByTable: new Map(), sql });

    expect(diagnostics).toEqual([
      {
        span: span(8, 15),
        message: "Column USER_ID must appear in the GROUP BY clause or be used in an aggregate function",
        severity: "error",
      },
    ]);
  });

  it("downgrades the severity to warning on PostgreSQL", () => {
    const analysis: SqlReferenceAnalysis = {
      tables: [],
      columns: [],
      group_by_violations: [{ span: span(8, 15), column: "name", qualifier: "u" }],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, { tables: [], columnsByTable: new Map(), databaseType: "postgres" });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("warning");
  });

  it("includes the qualifier in the message and tolerates missing sql", () => {
    const analysis: SqlReferenceAnalysis = {
      tables: [],
      columns: [],
      group_by_violations: [{ span: span(1, 5), column: "name", qualifier: "u" }],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, { tables: [], columnsByTable: new Map() });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe("Column u.name must appear in the GROUP BY clause or be used in an aggregate function");
    expect(diagnostics[0]?.severity).toBe("error");
  });
});

describe("buildSqlSemanticDiagnostics Oracle pseudo-columns", () => {
  const buildAnalysis = (sql: string, token: string, options: { quoted?: boolean; qualifier?: string } = {}) => {
    const tokenStart = sql.indexOf(token);
    const start = options.quoted ? tokenStart - 1 : tokenStart;
    const end = options.quoted ? tokenStart + token.length + 1 : tokenStart + token.length;
    return {
      tables: [{ name: "users", span: span(sql.indexOf("users") + 1, sql.indexOf("users") + "users".length) }],
      columns: [{ name: token, qualifier: options.qualifier ?? null, span: span(start + 1, end) }],
    };
  };

  it("accepts unqualified Oracle pseudo-columns missing from table metadata", () => {
    const sql = "SELECT * FROM users WHERE ROWNUM < 10;";
    const analysis = buildAnalysis(sql, "ROWNUM");

    const diagnostics = buildSqlSemanticDiagnostics(analysis, {
      tables: [{ name: "users" }],
      columnsByTable: new Map([["users", [{ name: "id" }]]]),
      loadedColumnTables: new Set(["users"]),
      sql,
      databaseType: "oracle",
    });

    expect(diagnostics).toEqual([]);
  });

  it("keeps validating quoted pseudo-column names as real columns", () => {
    const sql = 'SELECT * FROM users WHERE "ROWNUM" < 10;';
    const analysis = buildAnalysis(sql, "ROWNUM", { quoted: true });

    const diagnostics = buildSqlSemanticDiagnostics(analysis, {
      tables: [{ name: "users" }],
      columnsByTable: new Map([["users", [{ name: "id" }]]]),
      loadedColumnTables: new Set(["users"]),
      sql,
      databaseType: "oracle",
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["Unknown column ROWNUM"]);
  });
});
