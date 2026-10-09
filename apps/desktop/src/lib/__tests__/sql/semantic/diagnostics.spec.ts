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
