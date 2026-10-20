import { describe, expect, it } from "vitest";
import { executableStatementRanges, statementRangeAtCursor } from "@/lib/sql/sqlStatementRanges";
import type { DatabaseType } from "@/types/database";

describe("Kingbase compatibility statement boundaries", () => {
  it("uses Oracle alternative quotes without retaining the unresolved-mode hash-comment lexer", () => {
    const sql = "BEGIN\n v := q'[O'Reilly; text]';\n NULL;\nEND;\n/\nSELECT value#suffix FROM t;\nSELECT 2;";
    expect(executableStatementRanges(sql, "kingbase", { compatibilityMode: "oracle" })).toEqual(executableStatementRanges(sql, "gaussdb"));
  });

  it.each([undefined, "future_mode"])("preserves recognizable PL/SQL blocks while the mode is unresolved (%s)", (compatibilityMode) => {
    const sql = "BEGIN\n  NULL;\n  NULL;\nEND;\n/\nSELECT 1;";
    expect(executableStatementRanges(sql, "kingbase", { compatibilityMode })).toHaveLength(2);
    expect(executableStatementRanges(sql, "postgres", { compatibilityMode: "oracle" })).toEqual(executableStatementRanges(sql, "postgres"));
  });

  it.each([
    ["oracle", "gaussdb", "BEGIN\n  NULL;\n  NULL;\nEND;\n/\nSELECT 1;"],
    ["mysql", "mysql", "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 'a;'; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;"],
    ["pg", "postgres", "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 2;"],
    ["sqlserver", "sqlserver", "CREATE PROCEDURE p AS\nBEGIN\n SELECT 1;\n SELECT 2;\nEND\nGO\nSELECT 3;"],
  ] as const)("matches the %s parsing profile for cursor and execution ranges", (mode, type, sql) => {
    const options = { compatibilityMode: mode };
    expect(executableStatementRanges(sql, "kingbase", options)).toEqual(executableStatementRanges(sql, type as DatabaseType));
    const cursor = sql.indexOf("SELECT");
    expect(statementRangeAtCursor(sql, cursor, "kingbase", options)).toEqual(statementRangeAtCursor(sql, cursor, type as DatabaseType));
  });
});
