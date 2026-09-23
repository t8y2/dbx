import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandToSqlStatementWindow } from "@/lib/sql/insertValueHints";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

const diagnosticsSource = readFileSync(new URL("../../../components/editor/useQueryEditorDiagnostics.ts", import.meta.url), "utf8");

const extensionsSource = readFileSync(new URL("../../../components/editor/queryEditorSqlExtensions.ts", import.meta.url), "utf8");

describe("QueryEditor semantic highlighting while scrolling", () => {
  it("recognizes the large single-statement shape from the reported regression", () => {
    const sql = `CREATE TABLE [dbo].[code] ([id] int, [label] nvarchar(32));\nINSERT INTO [dbo].[code] ([id], [label]) VALUES\n${Array.from({ length: 240 }, (_, index) => `(${index}, N'row-${String(index).padStart(4, "0")}'),`).join("\n")}`;
    const insertStart = sql.indexOf("INSERT");
    const window = expandToSqlStatementWindow(sql, insertStart + 80, insertStart + 120, "sqlserver");

    expect(window.to - window.from).toBeGreaterThan(2_000);
    expect(window.from).toBe(insertStart);
  });

  it("reuses semantic statement windows across viewport-only updates", () => {
    expect(extensionsSource).toContain('private cachedDoc: import("@codemirror/state").Text | null = null;');
    expect(extensionsSource).toContain("private cachedWindows: Array<{");
    expect(extensionsSource).toContain("const cached = this.cachedWindows.find");
    expect(extensionsSource).toContain("const pendingWindows: Array<{ from: number; to: number }>");
    expect(extensionsSource).toContain("MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS = 32");
    expect(extensionsSource).toContain("this.cachedWindows.splice(0, this.cachedWindows.length - MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS)");
  });

  it("defers semantic highlighting while the document is changing", () => {
    expect(extensionsSource).toContain("SQL_SEMANTIC_HIGHLIGHT_DEBOUNCE_MS = 100");
    expect(extensionsSource).toContain("this.decorations = this.decorations.map(update.changes)");
    expect(extensionsSource).toContain("refreshSqlSemanticHighlightEffect.of(null)");
  });

  it("never exposes undefined decorations and prewarms the full document only once per document", () => {
    expect(extensionsSource).toContain("this.decorations = Decoration.none;");
    expect(extensionsSource).toContain('private prewarmedDoc: import("@codemirror/state").Text | null = null;');
    expect(extensionsSource).toContain("const shouldPrewarmFullDocument =");
    expect(extensionsSource).toContain("if (shouldPrewarmFullDocument) this.prewarmedDoc = doc;");
  });

  it("keeps existing highlights while the parser catches up instead of wiping them", () => {
    // An incomplete Lezer parse must not clear table-name decorations: the
    // deferred refresh retries, so a freshly mounted editor (tab switch) also
    // recovers even without a later viewport change.
    expect(extensionsSource).toContain("this.scheduleRefresh(currentView);");
    expect(extensionsSource).toContain("return this.decorations;");
  });

  it("keeps preview and diagnostics on the shared statement-range cache", () => {
    expect(queryEditorSource).toContain("executableStatementRangeCache = executableStatementRangeCacheForDoc");
    expect(diagnosticsSource).toContain('props.databaseType === "sqlserver" ? undefined : runtime.executableStatementRangeCache?.ranges');
    expect(queryEditorSource).toContain("get executableStatementRangeCache()");
    expect(queryEditorSource).toContain("set executableStatementRangeCache(value)");
    expect(queryEditorSource).toContain("const cursorRange = executableStatementRangeAtCursor(executableStatementRangeCache, cursorPos)");
  });
});
