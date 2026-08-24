import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandToSqlStatementWindow } from "@/lib/sql/insertValueHints";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor semantic highlighting while scrolling", () => {
  it("recognizes the large single-statement shape from the reported regression", () => {
    const sql = `CREATE TABLE [dbo].[code] ([id] int, [label] nvarchar(32));\nINSERT INTO [dbo].[code] ([id], [label]) VALUES\n${Array.from({ length: 240 }, (_, index) => `(${index}, N'row-${String(index).padStart(4, "0")}'),`).join("\n")}`;
    const insertStart = sql.indexOf("INSERT");
    const window = expandToSqlStatementWindow(sql, insertStart + 80, insertStart + 120, "sqlserver");

    expect(window.to - window.from).toBeGreaterThan(2_000);
    expect(window.from).toBe(insertStart);
  });

  it("reuses semantic statement windows across viewport-only updates", () => {
    expect(queryEditorSource).toContain('private cachedDoc: import("@codemirror/state").Text | null = null;');
    expect(queryEditorSource).toContain("private cachedWindows: Array<{");
    expect(queryEditorSource).toContain("const cached = this.cachedWindows.find");
    expect(queryEditorSource).toContain("const pendingWindows: Array<{ from: number; to: number }>");
    expect(queryEditorSource).toContain("MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS = 32");
    expect(queryEditorSource).toContain("this.cachedWindows.splice(0, this.cachedWindows.length - MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS)");
  });
});
