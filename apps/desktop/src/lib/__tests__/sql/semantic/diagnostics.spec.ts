import { describe, expect, it } from "vitest";
import { buildSqlSemanticDiagnostics, sqlTextSpanToOffsetRange } from "@/lib/sql/semantic/diagnostics";
import type { SqlReferenceAnalysis, SqlTextSpan } from "@/types/database";

const span = (startColumn: number, endColumn: number): SqlTextSpan => ({
  start_line: 1,
  start_column: startColumn,
  end_line: 1,
  end_column: endColumn,
});

describe("sqlTextSpanToOffsetRange inclusive column semantics", () => {
  it("converts 1-based inclusive single-character and multi-character spans to exact 0-based slice ranges", () => {
    const sql = "SELECT id, name AS user_name FROM users;";

    // Single character 'i' in "id" at line 1, column 8
    const singleChar = sqlTextSpanToOffsetRange(sql, { start_line: 1, start_column: 8, end_line: 1, end_column: 8 });
    expect(singleChar).toEqual({ from: 7, to: 8 });
    expect(sql.slice(singleChar!.from, singleChar!.to)).toBe("i");

    // Two-character "id" from column 8 to 9 (inclusive)
    const idRange = sqlTextSpanToOffsetRange(sql, { start_line: 1, start_column: 8, end_line: 1, end_column: 9 });
    expect(idRange).toEqual({ from: 7, to: 9 });
    expect(sql.slice(idRange!.from, idRange!.to)).toBe("id");

    // Nine-character "user_name"
    const aliasStart = sql.indexOf("user_name");
    const aliasSpan: SqlTextSpan = {
      start_line: 1,
      start_column: aliasStart + 1,
      end_line: 1,
      end_column: aliasStart + "user_name".length,
    };
    const aliasRange = sqlTextSpanToOffsetRange(sql, aliasSpan);
    expect(aliasRange).toEqual({ from: aliasStart, to: aliasStart + "user_name".length });
    expect(sql.slice(aliasRange!.from, aliasRange!.to)).toBe("user_name");
  });

  it("does not overshoot into trailing delimiters such as commas or semicolons", () => {
    const sql = "SELECT USER_ID, col FROM users GROUP BY USER_ID;";
    const userIdCol = sql.indexOf("USER_ID");
    // "USER_ID" is 7 characters; 1-based columns are 8..=14
    const spanBeforeComma: SqlTextSpan = {
      start_line: 1,
      start_column: userIdCol + 1,
      end_line: 1,
      end_column: userIdCol + "USER_ID".length,
    };
    const rangeBeforeComma = sqlTextSpanToOffsetRange(sql, spanBeforeComma);
    expect(rangeBeforeComma).toEqual({ from: userIdCol, to: userIdCol + 7 });
    expect(sql.slice(rangeBeforeComma!.from, rangeBeforeComma!.to)).toBe("USER_ID");
    expect(sql[rangeBeforeComma!.to]).toBe(",");

    const lastCol = sql.lastIndexOf("USER_ID");
    const spanBeforeSemi: SqlTextSpan = {
      start_line: 1,
      start_column: lastCol + 1,
      end_line: 1,
      end_column: lastCol + "USER_ID".length,
    };
    const rangeBeforeSemi = sqlTextSpanToOffsetRange(sql, spanBeforeSemi);
    expect(rangeBeforeSemi).toEqual({ from: lastCol, to: lastCol + 7 });
    expect(sql.slice(rangeBeforeSemi!.from, rangeBeforeSemi!.to)).toBe("USER_ID");
    expect(sql[rangeBeforeSemi!.to]).toBe(";");
  });

  it("handles multi-line spans without overshooting the end line column", () => {
    const sql = "SELECT\n  user_name\nFROM users;";
    const multiLineSpan: SqlTextSpan = {
      start_line: 2,
      start_column: 3,
      end_line: 2,
      end_column: 11,
    };
    const range = sqlTextSpanToOffsetRange(sql, multiLineSpan);
    expect(range).not.toBeNull();
    expect(sql.slice(range!.from, range!.to)).toBe("user_name");
  });

  it("returns null for invalid or empty spans", () => {
    const sql = "SELECT 1;";
    expect(sqlTextSpanToOffsetRange(sql, { start_line: 0, start_column: 0, end_line: 0, end_column: 0 })).toBeNull();
    expect(sqlTextSpanToOffsetRange(sql, { start_line: 1, start_column: 10, end_line: 1, end_column: 5 })).toBeNull();
    expect(sqlTextSpanToOffsetRange(sql, { start_line: 5, start_column: 1, end_line: 5, end_column: 2 })).toBeNull();
  });
});

describe("buildSqlSemanticDiagnostics GROUP BY violations", () => {
  it("maps analyzer GROUP BY violations to error diagnostics", () => {
    const sql = "SELECT USER_ID, SUM(MONEY) FROM users GROUP BY USER_NAME";
    const analysis: SqlReferenceAnalysis = {
      tables: [],
      columns: [],
      group_by_violations: [{ span: span(8, 14), column: "USER_ID", qualifier: null }],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, { tables: [], columnsByTable: new Map(), sql });

    expect(diagnostics).toEqual([
      {
        span: span(8, 14),
        message: "Column USER_ID must appear in the GROUP BY clause or be used in an aggregate function",
        severity: "error",
      },
    ]);
  });

  it("downgrades the severity to warning on PostgreSQL", () => {
    const analysis: SqlReferenceAnalysis = {
      tables: [],
      columns: [],
      group_by_violations: [{ span: span(8, 11), column: "name", qualifier: "u" }],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, { tables: [], columnsByTable: new Map(), databaseType: "postgres" });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("warning");
  });

  it("includes the qualifier in the message and tolerates missing sql", () => {
    const analysis: SqlReferenceAnalysis = {
      tables: [],
      columns: [],
      group_by_violations: [{ span: span(1, 4), column: "name", qualifier: "u" }],
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

describe("buildSqlSemanticDiagnostics projection aliases in GROUP BY / ORDER BY (#11627)", () => {
  it("accepts SELECT projection aliases in GROUP BY even when terminated with a semicolon", () => {
    const sql = "SELECT CASE WHEN submitter_id IS NOT NULL THEN 'A' ELSE 'B' END AS repair_type, COUNT(*) AS row_cnt FROM ipu_quotation GROUP BY repair_type;";
    const aliasStart = sql.indexOf("GROUP BY repair_type") + "GROUP BY ".length;
    const aliasEnd = aliasStart + "repair_type".length;

    const analysis: SqlReferenceAnalysis = {
      tables: [{ name: "ipu_quotation", span: span(sql.indexOf("ipu_quotation") + 1, sql.indexOf("ipu_quotation") + "ipu_quotation".length) }],
      columns: [
        { name: "submitter_id", qualifier: null, span: span(sql.indexOf("submitter_id") + 1, sql.indexOf("submitter_id") + "submitter_id".length) },
        { name: "repair_type", qualifier: null, span: span(aliasStart + 1, aliasEnd) },
      ],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, {
      tables: [{ name: "ipu_quotation" }],
      columnsByTable: new Map([["ipu_quotation", [{ name: "submitter_id" }]]]),
      loadedColumnTables: new Set(["ipu_quotation"]),
      sql,
      databaseType: "mysql",
    });

    expect(diagnostics).toEqual([]);
  });

  it("accepts projection aliases in ORDER BY terminated with a semicolon", () => {
    const sql = "SELECT id, name AS user_name FROM users ORDER BY user_name;";
    const aliasStart = sql.indexOf("ORDER BY user_name") + "ORDER BY ".length;
    const aliasEnd = aliasStart + "user_name".length;

    const analysis: SqlReferenceAnalysis = {
      tables: [{ name: "users", span: span(sql.indexOf("users") + 1, sql.indexOf("users") + "users".length) }],
      columns: [
        { name: "id", qualifier: null, span: span(sql.indexOf("id") + 1, sql.indexOf("id") + 2) },
        { name: "name", qualifier: null, span: span(sql.indexOf("name") + 1, sql.indexOf("name") + 4) },
        { name: "user_name", qualifier: null, span: span(aliasStart + 1, aliasEnd) },
      ],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, {
      tables: [{ name: "users" }],
      columnsByTable: new Map([["users", [{ name: "id" }, { name: "name" }]]]),
      loadedColumnTables: new Set(["users"]),
      sql,
      databaseType: "mysql",
    });

    expect(diagnostics).toEqual([]);
  });

  it("still reports genuinely unknown columns in GROUP BY", () => {
    const sql = "SELECT id, name AS user_name FROM users GROUP BY missing_col;";
    const colStart = sql.indexOf("missing_col");
    const colEnd = colStart + "missing_col".length;

    const analysis: SqlReferenceAnalysis = {
      tables: [{ name: "users", span: span(sql.indexOf("users") + 1, sql.indexOf("users") + "users".length) }],
      columns: [
        { name: "id", qualifier: null, span: span(sql.indexOf("id") + 1, sql.indexOf("id") + 2) },
        { name: "name", qualifier: null, span: span(sql.indexOf("name") + 1, sql.indexOf("name") + 4) },
        { name: "missing_col", qualifier: null, span: span(colStart + 1, colEnd) },
      ],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, {
      tables: [{ name: "users" }],
      columnsByTable: new Map([["users", [{ name: "id" }, { name: "name" }]]]),
      loadedColumnTables: new Set(["users"]),
      sql,
      databaseType: "mysql",
    });

    expect(diagnostics.map((d) => d.message)).toEqual(["Unknown column missing_col"]);
  });

  it("accepts projection aliases in GROUP BY when another expression contains a string literal with a semicolon", () => {
    const sql = "SELECT CASE WHEN status = ';' THEN 'semi;' ELSE 'other' END AS status_alias, COUNT(*) AS total FROM orders GROUP BY CONCAT(category, ';'), status_alias;";
    const aliasStart = sql.indexOf(", status_alias;") + ", ".length;
    const aliasEnd = aliasStart + "status_alias".length;

    const analysis: SqlReferenceAnalysis = {
      tables: [{ name: "orders", span: span(sql.indexOf("orders") + 1, sql.indexOf("orders") + "orders".length) }],
      columns: [
        { name: "status", qualifier: null, span: span(sql.indexOf("status") + 1, sql.indexOf("status") + "status".length) },
        { name: "category", qualifier: null, span: span(sql.indexOf("category") + 1, sql.indexOf("category") + "category".length) },
        { name: "status_alias", qualifier: null, span: span(aliasStart + 1, aliasEnd) },
      ],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, {
      tables: [{ name: "orders" }],
      columnsByTable: new Map([["orders", [{ name: "status" }, { name: "category" }]]]),
      loadedColumnTables: new Set(["orders"]),
      sql,
      databaseType: "mysql",
    });

    expect(diagnostics).toEqual([]);
  });

  it("accepts projection aliases in GROUP BY in the second statement of a multi-statement script", () => {
    const sql = "SELECT 1;\nSELECT id, name AS user_name FROM users GROUP BY user_name;";
    const secondLine = "SELECT id, name AS user_name FROM users GROUP BY user_name;";
    const aliasStartOnLine = secondLine.indexOf("GROUP BY user_name") + "GROUP BY ".length;
    const aliasEndOnLine = aliasStartOnLine + "user_name".length;

    const analysis: SqlReferenceAnalysis = {
      tables: [{ name: "users", span: { start_line: 2, start_column: secondLine.indexOf("users") + 1, end_line: 2, end_column: secondLine.indexOf("users") + "users".length } }],
      columns: [
        { name: "id", qualifier: null, span: { start_line: 2, start_column: secondLine.indexOf("id") + 1, end_line: 2, end_column: secondLine.indexOf("id") + 2 } },
        { name: "name", qualifier: null, span: { start_line: 2, start_column: secondLine.indexOf("name") + 1, end_line: 2, end_column: secondLine.indexOf("name") + 4 } },
        { name: "user_name", qualifier: null, span: { start_line: 2, start_column: aliasStartOnLine + 1, end_line: 2, end_column: aliasEndOnLine } },
      ],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, {
      tables: [{ name: "users" }],
      columnsByTable: new Map([["users", [{ name: "id" }, { name: "name" }]]]),
      loadedColumnTables: new Set(["users"]),
      sql,
      databaseType: "mysql",
    });

    expect(diagnostics).toEqual([]);
  });

  it("accepts projection aliases in GROUP BY in the first statement followed by another statement", () => {
    const sql = "SELECT id, name AS user_name FROM users GROUP BY user_name;\nSELECT 2;";
    const aliasStart = sql.indexOf("GROUP BY user_name") + "GROUP BY ".length;
    const aliasEnd = aliasStart + "user_name".length;

    const analysis: SqlReferenceAnalysis = {
      tables: [{ name: "users", span: span(sql.indexOf("users") + 1, sql.indexOf("users") + "users".length) }],
      columns: [
        { name: "id", qualifier: null, span: span(sql.indexOf("id") + 1, sql.indexOf("id") + 2) },
        { name: "name", qualifier: null, span: span(sql.indexOf("name") + 1, sql.indexOf("name") + 4) },
        { name: "user_name", qualifier: null, span: span(aliasStart + 1, aliasEnd) },
      ],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, {
      tables: [{ name: "users" }],
      columnsByTable: new Map([["users", [{ name: "id" }, { name: "name" }]]]),
      loadedColumnTables: new Set(["users"]),
      sql,
      databaseType: "mysql",
    });

    expect(diagnostics).toEqual([]);
  });

  it("still reports genuinely unknown columns in multi-statement scripts", () => {
    const sql = "SELECT 1;\nSELECT id, name AS user_name FROM users GROUP BY missing_col;";
    const secondLine = "SELECT id, name AS user_name FROM users GROUP BY missing_col;";
    const colStartOnLine = secondLine.indexOf("missing_col");
    const colEndOnLine = colStartOnLine + "missing_col".length;

    const analysis: SqlReferenceAnalysis = {
      tables: [{ name: "users", span: { start_line: 2, start_column: secondLine.indexOf("users") + 1, end_line: 2, end_column: secondLine.indexOf("users") + "users".length } }],
      columns: [
        { name: "id", qualifier: null, span: { start_line: 2, start_column: secondLine.indexOf("id") + 1, end_line: 2, end_column: secondLine.indexOf("id") + 2 } },
        { name: "name", qualifier: null, span: { start_line: 2, start_column: secondLine.indexOf("name") + 1, end_line: 2, end_column: secondLine.indexOf("name") + 4 } },
        { name: "missing_col", qualifier: null, span: { start_line: 2, start_column: colStartOnLine + 1, end_line: 2, end_column: colEndOnLine } },
      ],
    };

    const diagnostics = buildSqlSemanticDiagnostics(analysis, {
      tables: [{ name: "users" }],
      columnsByTable: new Map([["users", [{ name: "id" }, { name: "name" }]]]),
      loadedColumnTables: new Set(["users"]),
      sql,
      databaseType: "mysql",
    });

    expect(diagnostics.map((d) => d.message)).toEqual(["Unknown column missing_col"]);
  });
});
