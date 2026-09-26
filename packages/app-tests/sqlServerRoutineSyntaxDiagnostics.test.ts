import { expect, test } from "vitest";
import { buildSqlServerRoutineSyntaxDiagnostics, supportsSqlServerRoutineSyntaxDiagnostics, SQLSERVER_DECLARE_MISSING_DATA_TYPE_MESSAGE } from "../../apps/desktop/src/lib/sql/sqlServerRoutineSyntaxDiagnostics.ts";

function messages(sql: string, databaseType: Parameters<typeof buildSqlServerRoutineSyntaxDiagnostics>[1] = "sqlserver") {
  return buildSqlServerRoutineSyntaxDiagnostics(sql, databaseType).map((diagnostic) => diagnostic.message);
}

function spanAt(sql: string, token: string, occurrence = 0) {
  const upperSql = sql.toUpperCase();
  const upperToken = token.toUpperCase();
  let offset = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = upperSql.indexOf(upperToken, from);
    from = offset + token.length;
  }
  expect(offset).not.toBe(-1);
  const lineStart = sql.lastIndexOf("\n", offset - 1) + 1;
  const line = sql.slice(0, offset).split(/\r?\n/).length;
  return { start_line: line, start_column: offset - lineStart + 1, end_line: line, end_column: offset - lineStart + token.length };
}

test("reports a DECLARE default value that has no data type", () => {
  const sql = "ALTER PROCEDURE dbo.p_test @x INT AS\nBEGIN\n  DECLARE @temp_nums = 2;\n  SELECT @temp_nums AS v;\nEND";
  const diagnostics = buildSqlServerRoutineSyntaxDiagnostics(sql, "sqlserver");

  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([SQLSERVER_DECLARE_MISSING_DATA_TYPE_MESSAGE]);
  expect(diagnostics[0]?.span).toEqual(spanAt(sql, "=", 0));
  expect(diagnostics[0]?.severity).toBe("error");
});

test("reports every untyped declaration in a comma separated list", () => {
  const sql = "DECLARE @a INT = 1, @b = 2, @c VARCHAR(5) = 'x', @d = 4;";
  const diagnostics = buildSqlServerRoutineSyntaxDiagnostics(sql, "sqlserver");

  expect(diagnostics.map((diagnostic) => diagnostic.span)).toEqual([spanAt(sql, "=", 1), spanAt(sql, "=", 3)]);
});

test("tracks CRLF and mixed-case declarations", () => {
  const sql = "declare\r\n  @first = 1,\r\n  @second as = 2;";
  const diagnostics = buildSqlServerRoutineSyntaxDiagnostics(sql, "sqlserver");

  expect(diagnostics.map((diagnostic) => diagnostic.span)).toEqual([spanAt(sql, "=", 0), spanAt(sql, "=", 1)]);
});

test.each([
  "DECLARE @a INT = 1;",
  "DECLARE @a AS INT = 1;",
  "DECLARE @a DECIMAL(10,2) = 1.5, @b VARCHAR(20) = 'x,y';",
  "DECLARE @a INT, @b VARCHAR(5) = 'z';",
  "DECLARE @a INT;",
  "DECLARE @a dbo.MyType = 1;",
  "DECLARE @t TABLE (id INT, name VARCHAR(10) DEFAULT 'a,b');",
  "DECLARE @t TABLE (id INT, CONSTRAINT pk PRIMARY KEY (id));",
  "DECLARE @c CURSOR;",
  "DECLARE cur CURSOR FOR SELECT id, name FROM dbo.t;",
  "DECLARE @c CURSOR FOR SELECT a, b FROM dbo.t;",
  "SELECT @a = 1; SET @b = 2; UPDATE dbo.t SET @c = 3 WHERE id = 1;",
  "EXEC dbo.p @a = 1, @b = 2;",
  "SELECT * FROM dbo.t WHERE a = 1, b = 2;",
  "-- DECLARE @a = 1\n/* DECLARE @b = 2 */",
  "PRINT 'DECLARE @a = 1';",
  "EXEC sp_executesql N'DECLARE @a = 1';",
  "CREATE PROCEDURE dbo.p @a INT = 1 AS BEGIN SELECT @a; END",
  "CREATE FUNCTION dbo.f(@a INT = 1) RETURNS INT AS BEGIN RETURN @a; END",
  "DECLARE @a INT = (SELECT TOP 1 id FROM dbo.t);",
])("accepts the valid T-SQL declaration %s", (sql) => {
  expect(messages(sql, "sqlserver")).toEqual([]);
});

test("stops at the statement that follows an unterminated declaration list", () => {
  const sql = "DECLARE @a INT\nSELECT @b = 1\nDECLARE @c = 2";
  const diagnostics = buildSqlServerRoutineSyntaxDiagnostics(sql, "sqlserver");

  expect(diagnostics.map((diagnostic) => diagnostic.span)).toEqual([spanAt(sql, "=", 1)]);
});

test("stays silent for other dialects", () => {
  const sql = "DECLARE @a = 1;";
  expect(messages(sql, "mysql")).toEqual([]);
  expect(messages(sql, "oracle")).toEqual([]);
  expect(buildSqlServerRoutineSyntaxDiagnostics(sql, undefined)).toEqual([]);
});

test("only supports SQL Server", () => {
  expect(supportsSqlServerRoutineSyntaxDiagnostics("sqlserver")).toBe(true);
  expect(supportsSqlServerRoutineSyntaxDiagnostics("mysql")).toBe(false);
  expect(supportsSqlServerRoutineSyntaxDiagnostics(undefined)).toBe(false);
});
