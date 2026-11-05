import { describe, expect, it } from "vitest";
import { formatSqlText } from "@/lib/sql/sqlFormatter";
import { indentRoutineBlocks } from "@/lib/sql/routineBlockLayout";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

function tokenStream(sql: string, dialect: string): string[] {
  return tokenizeSqlSemantic(sql, dialect).map((tokenValue) => tokenValue.normalized);
}

const issueProcedure = `CREATE PROCEDURE AAA AS BEGIN
SELECT *
FROM SysUser su IF EXISTS (SELECT TOP 1 1 FROM SysUser su2) BEGIN PRINT '123';

END END`;

describe("routine block layout", () => {
  it("indents the body of a T-SQL procedure", async () => {
    expect(await formatSqlText(issueProcedure, "sqlserver")).toBe(["CREATE PROCEDURE AAA", "AS", "BEGIN", "  SELECT *", "  FROM SysUser su", "  IF EXISTS (SELECT TOP 1 1 FROM SysUser su2)", "  BEGIN", "    PRINT '123';", "  END", "END"].join("\n"));
  });

  it("follows the configured indent width", async () => {
    const formatted = await formatSqlText(issueProcedure, "sqlserver", { tabWidth: 4 });

    expect(formatted).toContain("\n    SELECT *");
    expect(formatted).toContain("\n        PRINT '123';");
    expect(formatted).toContain("\n    END\nEND");
  });

  it("indents with tabs when the settings ask for tabs", async () => {
    const formatted = await formatSqlText(issueProcedure, "sqlserver", { useTabs: true, tabWidth: 4 });

    expect(formatted).toContain("\n\tSELECT *");
    expect(formatted).toContain("\n\t\tPRINT '123';");
  });

  it.each([
    ["sqlserver", issueProcedure],
    ["oracle", "CREATE OR REPLACE PROCEDURE p(x IN NUMBER) AS BEGIN IF x > 0 THEN DBMS_OUTPUT.PUT_LINE('pos'); ELSE DBMS_OUTPUT.PUT_LINE('neg'); END IF; END;"],
    ["mysql", "CREATE PROCEDURE p() BEGIN SELECT 1; END"],
  ])("keeps every token of a %s routine", async (dialect, sql) => {
    const formatted = await formatSqlText(sql, dialect);

    expect(tokenStream(formatted, dialect)).toEqual(tokenStream(sql, dialect));
  });

  it("is idempotent", async () => {
    const once = await formatSqlText(issueProcedure, "sqlserver");

    expect(await formatSqlText(once, "sqlserver")).toBe(once);
  });

  it("preserves the end of MySQL hash comments before a routine header", () => {
    const sql = "# keep this comment\nCREATE PROCEDURE p() BEGIN SELECT 1; END;";
    const formatted = indentRoutineBlocks(sql, "mysql", 2, false);

    expect(formatted).toMatch(/^# keep this comment\nCREATE PROCEDURE/);
    expect(tokenStream(formatted, "mysql")).toEqual(tokenStream(sql, "mysql"));
  });

  it("keeps a CASE expression on the line its clause produced", async () => {
    const formatted = await formatSqlText("CREATE PROCEDURE p AS BEGIN SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END AS label FROM t; END", "sqlserver");

    expect(formatted).toContain("SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END AS label");
    expect(formatted.endsWith("\nEND")).toBe(true);
  });

  it("does not nest the statements after BEGIN TRANSACTION", async () => {
    const formatted = await formatSqlText("CREATE PROCEDURE p AS BEGIN BEGIN TRANSACTION; UPDATE t SET a = 1; COMMIT; END", "sqlserver");

    expect(formatted).toBe(["CREATE PROCEDURE p", "AS", "BEGIN", "  BEGIN TRANSACTION;", "  UPDATE t SET a = 1;", "  COMMIT;", "END"].join("\n"));
  });

  it("keeps BEGIN TRY / END CATCH together and nests their bodies", async () => {
    const formatted = await formatSqlText("CREATE PROCEDURE p AS BEGIN BEGIN TRY SELECT 1; END TRY BEGIN CATCH SELECT 2; END CATCH END", "sqlserver");

    expect(formatted).toContain("\n  BEGIN TRY\n");
    expect(formatted).toContain("\n  END TRY\n");
    expect(formatted).toContain("\n  BEGIN CATCH\n");
    expect(formatted).toContain("\n  END CATCH\n");
  });

  it("indents a PL/SQL IF ... THEN body and its ELSE branch", async () => {
    const formatted = await formatSqlText("CREATE OR REPLACE PROCEDURE p AS BEGIN IF x > 0 THEN DBMS_OUTPUT.PUT_LINE('pos'); ELSE DBMS_OUTPUT.PUT_LINE('neg'); END IF; END;", "oracle");

    expect(formatted).toBe(["CREATE OR REPLACE PROCEDURE p", "AS", "BEGIN", "  IF x > 0 THEN", "    DBMS_OUTPUT.PUT_LINE('pos');", "  ELSE", "    DBMS_OUTPUT.PUT_LINE('neg');", "  END IF;", "END;"].join("\n"));
  });

  it("collapses a signature the clause layout split one token per line", () => {
    const split = ["CREATE", "OR", "REPLACE", "PROCEDURE", "p", "(x IN NUMBER)", "AS", "BEGIN", "SELECT 1;", "END;"].join("\n");

    expect(indentRoutineBlocks(split, "oracle", 2, false)).toBe(["CREATE OR REPLACE PROCEDURE p (x IN NUMBER)", "AS", "BEGIN", "  SELECT 1;", "END;"].join("\n"));
  });

  it("leaves input that is not a routine definition alone", () => {
    for (const sql of ["SELECT 1", "BEGIN TRANSACTION;\nSELECT 1;\nCOMMIT;", "CREATE TABLE t (a int)", "CREATE PROCEDURE p AS SELECT 1"]) {
      expect(indentRoutineBlocks(sql, "sqlserver", 2, false)).toBe(sql);
    }
  });
});

describe("Oracle package layout #13650", () => {
  const sql =
    "create or replace package body pkg is procedure p(p_date in date default sysdate) is cursor goods_cur is select * from goods for update; v_count number; v_log varchar2(200); begin v_count := 1; insert into logs(id, log) values(v_count,v_log); end p; procedure q is begin null; end q; end pkg;";

  it.each([false, true])("indents member signatures, declarations and named ends (custom rules=%s)", async (customRulesEnabled) => {
    const options = { customRulesEnabled };
    const result = await formatSqlText(sql, "oracle", options);
    expect(result).toMatch(/^CREATE OR replace PACKAGE BODY pkg IS\n  PROCEDURE p .* IS\n/);
    expect(result).toContain("\n    CURSOR goods_cur IS\n      SELECT *\n      FROM goods\n      FOR UPDATE;\n    v_count number;");
    expect(result).toContain("\n  BEGIN\n    v_count := 1;");
    expect(result).toContain("\n  END p;\n  PROCEDURE q IS\n  BEGIN\n    NULL;\n  END q;\nEND pkg;");
    expect(tokenStream(result, "oracle")).toEqual(tokenStream(sql, "oracle"));
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("keeps package initialization outside member bodies", async () => {
    const source = "create or replace package body pkg is procedure p is begin null; end p; begin p; end pkg;";
    const result = await formatSqlText(source, "oracle");
    expect(result).toContain("\n  END p;\nBEGIN\n  p;\nEND pkg;");
    expect(tokenStream(result, "oracle")).toEqual(tokenStream(source, "oracle"));
    expect(await formatSqlText(result, "oracle")).toBe(result);
  });
});

describe("Oracle package boundaries #13650", () => {
  it.each([2, 4] as const)("keeps quoted member ends and nested blocks with indent=%s", async (tabWidth) => {
    const source = 'create or replace package body "Pkg" is procedure "Run" is v number; begin if v > 0 then begin null; end; else null; end if; end "Run"; end "Pkg";';
    const result = await formatSqlText(source, "oracle", { tabWidth });
    expect(result).toContain(`\n${" ".repeat(tabWidth)}END "Run";\nEND "Pkg";`);
    expect(tokenStream(result, "oracle")).toEqual(tokenStream(source, "oracle"));
    expect(await formatSqlText(result, "oracle", { tabWidth })).toBe(result);
  });
});
