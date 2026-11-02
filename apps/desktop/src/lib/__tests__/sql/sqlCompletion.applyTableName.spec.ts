import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

// Regression test for https://github.com/t8y2/dbx/issues/13829
// A table named `apply` collided with the CROSS/OUTER APPLY operator trigger:
// after `FROM apply `, clause keywords (WHERE/ORDER…) were never suggested.
describe("table named apply must not suppress clause keywords (#13829)", () => {
  function labels(sql: string, databaseType: string) {
    return buildSqlCompletionItems(sql, sql.length, {
      databaseType: databaseType as never,
      tables: [
        { name: "apply", columns: [{ name: "id" }] },
        { name: "t1", columns: [{ name: "id" }] },
      ] as never,
      columnsByTable: new Map(),
    }).map((item) => `${item.type}:${item.label}`);
  }

  it("offers WHERE while typing a clause keyword after FROM apply", () => {
    expect(labels("SELECT *\nFROM apply wher", "postgres")).toContain("keyword:WHERE");
  });

  it("offers WHERE while typing after FROM apply for SQL Server too (bare apply = table name)", () => {
    expect(labels("SELECT *\nFROM apply wher", "sqlserver")).toContain("keyword:WHERE");
  });

  it("still treats CROSS APPLY as a table-source trigger in SQL Server", () => {
    const kinds = labels("SELECT *\nFROM t1 CROSS APPLY ", "sqlserver");
    expect(kinds.some((label) => label.startsWith("keyword:"))).toBe(false);
  });

  it("still treats OUTER APPLY as a table-source trigger in SQL Server", () => {
    const kinds = labels("SELECT *\nFROM t1 OUTER APPLY ", "sqlserver");
    expect(kinds.some((label) => label.startsWith("keyword:"))).toBe(false);
  });
});
