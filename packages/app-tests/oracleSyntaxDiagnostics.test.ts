import { expect, test } from "vitest";
import { buildOracleSyntaxDiagnostics, supportsOracleSyntaxDiagnostics } from "../../apps/desktop/src/lib/sql/oracleSyntaxDiagnostics.ts";

const ORACLE_DEFAULT_ORDER_MESSAGE = "Oracle DEFAULT clause must appear before NOT NULL";

function diagnosticMessages(sql: string, databaseType: "oracle" | "oceanbase-oracle" | "mysql" = "oracle") {
  return buildOracleSyntaxDiagnostics(sql, databaseType).map((diagnostic) => diagnostic.message);
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
  return {
    start_line: sql.slice(0, offset).split(/\r?\n/).length,
    start_column: offset - lineStart + 1,
    end_line: sql.slice(0, offset).split(/\r?\n/).length,
    end_column: offset - lineStart + token.length,
  };
}

test("reports DEFAULT after NOT NULL and points at DEFAULT", () => {
  const sql = "CREATE TABLE t (id NUMBER NOT NULL DEFAULT 0)";
  const diagnostics = buildOracleSyntaxDiagnostics(sql, "oracle");

  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([ORACLE_DEFAULT_ORDER_MESSAGE]);
  expect(diagnostics[0]?.span).toEqual(spanAt(sql, "DEFAULT"));
  expect(diagnostics[0]?.severity).toBe("error");
});

test("handles multiline, mixed-case, and multiple column definitions", () => {
  const sql = `CREATE TABLE t (
  id NUMBER
     NOT NULL
     DEFAULT 0,
  status NUMBER DEFAULT 1 NOT NULL,
  archived NUMBER not null default 0
)`;
  const diagnostics = buildOracleSyntaxDiagnostics(sql, "oracle");

  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([ORACLE_DEFAULT_ORDER_MESSAGE, ORACLE_DEFAULT_ORDER_MESSAGE]);
  expect(diagnostics.map((diagnostic) => diagnostic.span)).toEqual([spanAt(sql, "DEFAULT"), spanAt(sql, "DEFAULT", 2)]);
});

test.each([
  "CREATE TABLE t (id NUMBER DEFAULT 0 NOT NULL)",
  "CREATE TABLE t (id NUMBER DEFAULT ON NULL 0 NOT NULL)",
  "CREATE TABLE t (id NUMBER NOT NULL)",
  "CREATE TABLE t (id NUMBER DEFAULT 0)",
  "CREATE TABLE t (value VARCHAR2(100) DEFAULT 'NOT NULL DEFAULT' NOT NULL)",
  "CREATE TABLE t (id NUMBER /* NOT NULL DEFAULT */ DEFAULT 0 NOT NULL)",
  "SELECT 'NOT NULL DEFAULT' FROM dual",
  "CREATE TABLE t (id NUMBER DEFAULT CASE WHEN 1 IS NOT NULL THEN 1 ELSE 0 END NOT NULL)",
  "CREATE TABLE t (id NUMBER NOT NULL, CONSTRAINT c CHECK (id IS NOT NULL))",
])("does not report valid or unrelated SQL: %s", (sql) => {
  expect(diagnosticMessages(sql)).toEqual([]);
});

test("covers Oracle ALTER TABLE ADD column definitions", () => {
  const sql = `ALTER TABLE t ADD (
  valid_col NUMBER DEFAULT 0 NOT NULL,
  invalid_col NUMBER NOT NULL DEFAULT 1
)`;

  const diagnostics = buildOracleSyntaxDiagnostics(sql, "oracle");
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([ORACLE_DEFAULT_ORDER_MESSAGE]);
  expect(diagnostics[0]?.span).toEqual(spanAt(sql, "DEFAULT", 1));
});

test("supports single-column ALTER TABLE ADD syntax", () => {
  expect(diagnosticMessages("ALTER TABLE t ADD id NUMBER NOT NULL DEFAULT 0")).toEqual([ORACLE_DEFAULT_ORDER_MESSAGE]);
  expect(diagnosticMessages("ALTER TABLE t ADD id NUMBER DEFAULT 0 NOT NULL")).toEqual([]);
});

test("keeps the rule isolated to Oracle-family database types", () => {
  const sql = "CREATE TABLE t (id NUMBER NOT NULL DEFAULT 0)";

  expect(supportsOracleSyntaxDiagnostics("oracle")).toBe(true);
  expect(supportsOracleSyntaxDiagnostics("oceanbase-oracle")).toBe(true);
  expect(supportsOracleSyntaxDiagnostics("mysql")).toBe(false);
  expect(supportsOracleSyntaxDiagnostics()).toBe(false);
  expect(buildOracleSyntaxDiagnostics(sql, "mysql")).toEqual([]);
});
