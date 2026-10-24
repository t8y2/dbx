import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

describe("SQL Server table-valued function completion (#13131)", () => {
  function labelsFor(sql: string) {
    return buildSqlCompletionItems(sql, sql.length, {
      databaseType: "sqlserver",
      tables: [{ name: "orders" }, { name: "customers" }],
      objects: [
        { name: "SplitCsv", schema: "dbo", type: "function", signature: "dbo.SplitCsv(@csv NVARCHAR(MAX))" },
        { name: "TotalSales", schema: "dbo", type: "function" },
        { name: "GetCustomerName", schema: "dbo", type: "function" },
        { name: "ArchiveOldOrders", schema: "dbo", type: "procedure" },
      ],
      columnsByTable: new Map(),
    }).map((item) => item.label);
  }

  it("offers functions as relation sources after FROM", () => {
    expect(labelsFor("SELECT * FROM ")).toEqual(expect.arrayContaining(["SplitCsv", "TotalSales"]));
    expect(labelsFor("SELECT * FROM dbo.")).toEqual(expect.arrayContaining(["SplitCsv"]));
  });

  it("keeps procedures out of the FROM candidate set", () => {
    expect(labelsFor("SELECT * FROM ")).not.toContain("ArchiveOldOrders");
  });

  it("does not offer sqlserver metadata objects to other engines", () => {
    const labels = buildSqlCompletionItems("SELECT * FROM ", 14, {
      databaseType: "mysql",
      tables: [{ name: "orders" }],
      objects: [{ name: "SplitCsv", schema: "dbo", type: "function" }],
      columnsByTable: new Map(),
    }).map((item) => item.label);
    expect(labels).not.toContain("SplitCsv");
  });
});
