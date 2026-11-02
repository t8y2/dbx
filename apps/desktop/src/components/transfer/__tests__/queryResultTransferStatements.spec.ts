import { describe, expect, it } from "vitest";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { postgresTransferSequenceSyncSql, queryResultTransferInsertSql, withSqlServerIdentityInsert } from "../queryResultTransferStatements";

describe("query result transfer statements", () => {
  it("uses Oracle INSERT ALL for multiple rows and portable individual inserts on JDBC variants", () => {
    for (const type of ["oracle", "oceanbase-oracle"] as const) {
      expect(queryResultTransferInsertSql('"t"', ['"id"'], ["(1)", "(2)"], type)).toEqual(['INSERT ALL\nINTO "t" ("id") VALUES (1)\nINTO "t" ("id") VALUES (2)\nSELECT 1 FROM dual']);
    }
    for (const type of ["dameng", "yashandb", "iris", "db2"] as const) expect(queryResultTransferInsertSql('"t"', ['"id"'], ["(1)", "(2)"], type)).toEqual(['INSERT INTO "t" ("id") VALUES (1)', 'INSERT INTO "t" ("id") VALUES (2)']);
  });

  it("places the PostgreSQL identity override before VALUES", () => {
    expect(queryResultTransferInsertSql('"t"', ['"id"'], ["(1)"], "postgres", true)).toEqual(['INSERT INTO "t" ("id") OVERRIDING SYSTEM VALUE VALUES (1)']);
    expect(queryResultTransferInsertSql('"t"', ['"id"'], [], "postgres", true)).toEqual([]);
  });

  it("restores SQL Server session state and rethrows percent-containing error text safely", () => {
    const sql = withSqlServerIdentityInsert("[t]", ["INSERT INTO [t] ([id]) VALUES (1)"]);
    expect(sql.match(/SET IDENTITY_INSERT \[t\] OFF/g)).toHaveLength(2);
    expect(sql).toContain("RAISERROR(N'%s', 16, 1, @dbx_transfer_error)");
    expect(sql.indexOf("ERROR_MESSAGE()")).toBeLessThan(sql.lastIndexOf("SET IDENTITY_INSERT [t] OFF"));
    // executeInTransaction sends this array element as one SQL Server batch;
    // it must keep ON, inserts and both OFF paths within that same session.
    expect(sql).toContain("BEGIN TRY\nSET IDENTITY_INSERT [t] ON;");
  });

  it("synchronizes PostgreSQL sequences in their direction after locking and without setval", () => {
    const sql = postgresTransferSequenceSyncSql('"public"."copy"', "id");
    expect(sql).toContain("SELECT increment_by FROM ");
    expect(sql).toContain("SELECT seqincrement FROM pg_catalog.pg_sequence");
    expect(sql).toContain("CASE WHEN dbx_increment > 0 THEN 'MAX' ELSE 'MIN' END");
    expect(sql).toContain("dbx_next := dbx_last + CASE WHEN dbx_called THEN dbx_increment ELSE 0 END");
    expect(sql).toContain("FLOOR((dbx_edge - dbx_next) / dbx_increment) * dbx_increment");
    expect(sql.indexOf("' INCREMENT BY '")).toBeLessThan(sql.indexOf("SELECT last_value"));
    expect(sql).not.toContain("setval(");
    expect(sql).toContain("END;\n$dbx_transfer$");
    expect(splitSqlStatementRanges(sql, "postgres")).toHaveLength(1);
  });

  it("quotes PostgreSQL names and chooses a delimiter that cannot occur in user input", () => {
    const sql = postgresTransferSequenceSyncSql('"s"."copy$dbx_transfer$"', "id'\"\\");
    expect(sql).toMatch(/^DO \$dbx_transfer_\$/);
    expect(sql).toContain("pg_get_serial_sequence");
    expect(splitSqlStatementRanges(sql, "postgres")).toHaveLength(1);
  });
});
