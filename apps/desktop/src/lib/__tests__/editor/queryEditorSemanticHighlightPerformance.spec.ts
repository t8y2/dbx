import { describe, expect, it } from "vitest";
import { expandToSqlStatementWindow } from "@/lib/sql/insertValueHints";

describe("QueryEditor semantic highlighting while scrolling", () => {
  it("recognizes the large single-statement shape from the reported regression", () => {
    const sql = `CREATE TABLE [dbo].[code] ([id] int, [label] nvarchar(32));\nINSERT INTO [dbo].[code] ([id], [label]) VALUES\n${Array.from({ length: 240 }, (_, index) => `(${index}, N'row-${String(index).padStart(4, "0")}'),`).join("\n")}`;
    const insertStart = sql.indexOf("INSERT");
    const window = expandToSqlStatementWindow(sql, insertStart + 80, insertStart + 120, "sqlserver");

    expect(window.to - window.from).toBeGreaterThan(2_000);
    expect(window.from).toBe(insertStart);
  });
});
