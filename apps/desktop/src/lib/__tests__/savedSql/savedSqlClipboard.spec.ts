import { describe, expect, it } from "vitest";
import { nextSavedSqlCopyName, savedSqlClipboardFileIds, savedSqlPasteTargetForNode } from "@/lib/savedSql/savedSqlClipboard";
import { savedSqlExportFileName } from "@/lib/savedSql/savedSqlExport";
import type { TreeNode } from "@/types/database";

describe("saved SQL tree clipboard", () => {
  it("collects unique saved SQL ids from tree rows", () => {
    const nodes: TreeNode[] = [
      { id: "file-1", label: "report.sql", type: "saved-sql-file", savedSqlId: "sql-1" },
      { id: "file-1-copy", label: "report.sql", type: "saved-sql-file", savedSqlId: "sql-1" },
      { id: "table-1", label: "report", type: "table" },
    ];

    expect(savedSqlClipboardFileIds(nodes)).toEqual(["sql-1"]);
  });

  it("resolves database scope from a Queries node or saved SQL row", () => {
    expect(savedSqlPasteTargetForNode({ type: "saved-sql-root", connectionId: "conn-1", catalog: "hive", database: "app" })).toEqual({ connectionId: "conn-1", catalog: "hive", database: "app", schema: undefined });
    expect(savedSqlPasteTargetForNode({ type: "saved-sql-file", connectionId: "conn-1", database: "app", schema: "public" })).toEqual({ connectionId: "conn-1", catalog: undefined, database: "app", schema: "public" });
    expect(savedSqlPasteTargetForNode({ type: "schema", connectionId: "conn-1", database: "app", schema: "public" })).toBeNull();
  });

  it("uses Navicat-style incrementing copy suffixes", () => {
    expect(nextSavedSqlCopyName("query.sql", new Set(["query.sql"]))).toBe("query_copy1.sql");
    expect(nextSavedSqlCopyName("query.sql", new Set(["query.sql", "query_copy1.sql", "QUERY_COPY2.SQL"]))).toBe("query_copy3.sql");
    expect(nextSavedSqlCopyName("query_copy1.sql", new Set(["query_copy1.sql"]))).toBe("query_copy2.sql");
  });

  it("sanitizes exported SQL file names", () => {
    expect(savedSqlExportFileName("report<2026>:daily")).toBe("report_2026__daily.sql");
  });
});
