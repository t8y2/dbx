import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

describe("SQL Server T-SQL keyword completion", () => {
  function labelsFor(prefix: string): string[] {
    return buildSqlCompletionItems(prefix, prefix.length, {
      databaseType: "sqlserver",
      tables: [],
      columnsByTable: new Map(),
    }).map((item) => item.label);
  }

  it("offers DECLARE ahead of DECIMAL for the decl prefix (issue #9319)", () => {
    const labels = labelsFor("decl");

    expect(labels).toContain("DECLARE");
    expect(labels).toContain("DECIMAL");
    expect(labels.indexOf("DECLARE")).toBeLessThan(labels.indexOf("DECIMAL"));
  });

  it.each(["declare", "exec", "print", "raiserror", "waitfor", "throw", "isnull", "getdate", "newid", "scope_identity", "error_message"])("offers %s for a SQL Server batch", (keyword) => {
    expect(labelsFor(keyword.slice(0, -1))).toContain(keyword.toUpperCase());
  });
});
