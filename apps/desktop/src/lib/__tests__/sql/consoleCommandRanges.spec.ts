import { describe, expect, it } from "vitest";
import { executableStatementRanges, splitSqlStatementRanges, statementRangeAtCursor } from "@/lib/sql/sqlStatementRanges";

function rangeSqlTexts(ranges: Array<{ sql: string }>): string[] {
  return ranges.map((range) => range.sql.trim());
}

describe("SQL*Plus console command statement ranges", () => {
  it("splits console command lines from SQL for oracle and yashandb", () => {
    const sql = ["SET TIMING ON", "SELECT 1;", "DESC emp", "exec dbms_stats.gather_table_stats('S','T')", "show user", "PROMPT step 1; load", "SPOOL out.txt"].join("\n");

    for (const databaseType of ["oracle", "yashandb", "dameng"] as const) {
      expect(rangeSqlTexts(splitSqlStatementRanges(sql, databaseType))).toEqual(["SET TIMING ON", "SELECT 1", "DESC emp", "exec dbms_stats.gather_table_stats('S','T')", "show user", "PROMPT step 1; load", "SPOOL out.txt"]);
    }
  });

  it("keeps SET TRANSACTION on the SQL path", () => {
    const sql = "SET TRANSACTION READ ONLY;\nSET TIMING ON\nSELECT 1;";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "oracle"))).toEqual(["SET TRANSACTION READ ONLY", "SET TIMING ON", "SELECT 1"]);
  });

  it("keeps console commands disabled for other Oracle-family databases", () => {
    const sql = "DESC emp\nSELECT 1;";
    for (const databaseType of ["gaussdb", "oceanbase-oracle"] as const) {
      expect(rangeSqlTexts(splitSqlStatementRanges(sql, databaseType))).toEqual(["DESC emp\nSELECT 1"]);
    }
  });

  it("keeps SET CONSTRAINTS on the SQL path", () => {
    const sql = "SET CONSTRAINTS ALL\nDEFERRED;\nSET TIMING ON\nSELECT 1;";
    for (const databaseType of ["oracle", "yashandb"] as const) {
      expect(rangeSqlTexts(splitSqlStatementRanges(sql, databaseType))).toEqual(["SET CONSTRAINTS ALL\nDEFERRED", "SET TIMING ON", "SELECT 1"]);
    }
  });

  it("keeps DM8 native SET statements separate from disql commands", () => {
    const sql = "SET SCHEMA\nDBX_TEST;\nSET TIMING ON\nDESC emp\nEXEC p(1); -- note\nRUN\nSHOW USER\nEXIT";
    const expected = ["SET SCHEMA\nDBX_TEST", "SET TIMING ON", "DESC emp", "EXEC p(1); -- note", "RUN", "SHOW USER", "EXIT"];
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "dameng"))).toEqual(expected);
    for (const statement of expected) expect(statementRangeAtCursor(sql, sql.indexOf(statement), "dameng")?.sql).toBe(statement);
    for (const statement of ["SET SESSION TRANSACTION READ WRITE", "SET IDENTITY_INSERT t ON", "SET TIME ZONE '+08:00'"]) {
      expect(rangeSqlTexts(splitSqlStatementRanges(`${statement};\nDESC t`, "dameng"))).toEqual([statement, "DESC t"]);
    }
    expect(rangeSqlTexts(splitSqlStatementRanges("SET\nSELECT 1;", "dameng"))).toEqual(["SET\nSELECT 1"]);
    expect(rangeSqlTexts(splitSqlStatementRanges("SET TIME\nZONE '+08:00';\nDESC t", "dameng"))).toEqual(["SET TIME\nZONE '+08:00'", "DESC t"]);
    expect(rangeSqlTexts(splitSqlStatementRanges("SET TIME ON; SELECT 1;", "dameng"))).toEqual(["SET TIME ON", "SELECT 1"]);
  });

  it.each(["EXIT", "RUN", "PROMPT", "DESC", "SET"])("isolates argumentless %s before SQL", (command) => {
    const sql = `${command}\nSELECT 1;\nSELECT 2;`;
    for (const databaseType of ["oracle", "yashandb"] as const) {
      expect(rangeSqlTexts(splitSqlStatementRanges(sql, databaseType))).toEqual([command, "SELECT 1", "SELECT 2"]);
      expect(statementRangeAtCursor(sql, sql.indexOf("SELECT 1"), databaseType)?.sql).toBe("SELECT 1");
    }
  });

  it("keeps unknown first words as SQL", () => {
    expect(rangeSqlTexts(splitSqlStatementRanges("DESCRIPTION OF THINGS\nSELECT 1;", "oracle"))).toEqual(["DESCRIPTION OF THINGS\nSELECT 1"]);
  });

  it("does not split a console line that continues an unterminated statement", () => {
    expect(rangeSqlTexts(splitSqlStatementRanges("SELECT 1\nDESC emp", "oracle"))).toEqual(["SELECT 1\nDESC emp"]);
  });

  it("keeps PL/SQL blocks and their slash delimiter intact", () => {
    const sql = "BEGIN\n  NULL;\nEND;\n/\nDESC emp";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "oracle"))).toEqual(["BEGIN\n  NULL;\nEND;", "DESC emp"]);
  });

  it("resolves the console statement at the cursor", () => {
    const sql = "SET TIMING ON\nSELECT 1;\nDESC emp\nSELECT 2;";
    expect(statementRangeAtCursor(sql, sql.indexOf("TIMING"), "oracle")?.sql).toBe("SET TIMING ON");
    expect(statementRangeAtCursor(sql, sql.indexOf("emp"), "yashandb")?.sql).toBe("DESC emp");
  });

  it("exposes console statements as executable statements for run buttons", () => {
    const sql = "DESC emp\nSELECT 1;";
    expect(rangeSqlTexts(executableStatementRanges(sql, "oracle"))).toEqual(["DESC emp", "SELECT 1"]);
  });

  it("isolates psql console command lines for postgres-family databases", () => {
    const sql = "\\timing on\n\\d emp\nSELECT 1;\n\\dt+";
    for (const databaseType of ["postgres", "opengauss", "gaussdb"] as const) {
      expect(rangeSqlTexts(splitSqlStatementRanges(sql, databaseType))).toEqual(["\\d emp", "SELECT 1", "\\dt+"]);
    }
    expect(statementRangeAtCursor(sql, sql.indexOf("emp"), "postgres")?.sql).toBe("\\d emp");
  });

  it("keeps other psql meta commands on their existing path", () => {
    const sql = "\\dv\nSELECT 1;";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "postgres"))).toEqual(["\\dv\nSELECT 1"]);
  });

  it("keeps mysql console-looking syntax as server SQL", () => {
    const sql = "DESC emp;\nSHOW TABLES;\nUSE other;";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "mysql"))).toEqual(["DESC emp", "SHOW TABLES", "USE other"]);
  });
});
