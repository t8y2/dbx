import { describe, expect, it } from "vitest";
import { savedSqlBatchReassignment } from "@/lib/savedSql/savedSqlBatchTarget";
import { savedSqlBatchErrorMessage } from "@/lib/savedSql/savedSqlErrors";
import type { SavedSqlFile, SavedSqlFolder } from "@/types/database";

const file: SavedSqlFile = {
  id: "file-1",
  connectionId: "source",
  folderId: "folder-1",
  name: "report.sql",
  database: "sales",
  catalog: "hive",
  schema: "reporting",
  sql: "SELECT 1;",
  orderIndex: 2,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const folder: SavedSqlFolder = {
  id: "folder-1",
  connectionId: "source",
  name: "Reports",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("savedSqlBatchReassignment", () => {
  it("keeps the schema and folder when the execution namespace is unchanged", () => {
    expect(savedSqlBatchReassignment(file, folder, { connectionId: "source", database: "sales", catalog: "hive" })).toEqual({
      target: { connectionId: "source", database: "sales", catalog: "hive", schema: "reporting" },
      folderId: "folder-1",
    });
  });

  it("clears the old catalog and schema while preserving the library folder across connections", () => {
    expect(savedSqlBatchReassignment(file, folder, { connectionId: "target", database: "analytics" })).toEqual({
      target: { connectionId: "target", database: "analytics", catalog: undefined, schema: undefined },
      folderId: "folder-1",
    });
  });

  it("clears the schema when only the database changes and drops an orphaned folder", () => {
    expect(savedSqlBatchReassignment(file, undefined, { connectionId: "source", database: "analytics", catalog: "hive" })).toEqual({
      target: { connectionId: "source", database: "analytics", catalog: "hive", schema: undefined },
      folderId: undefined,
    });
  });
});

describe("savedSqlBatchErrorMessage", () => {
  it("keeps file identities in a bounded aggregate failure message", () => {
    const failures = [
      { fileName: "one.sql", error: { code: "SAVED_SQL_NAME_CONFLICT", fileName: "one.sql" } },
      { fileName: "two.sql", error: new Error("write failed") },
      { fileName: "three.sql", error: new Error("offline") },
    ];

    expect(savedSqlBatchErrorMessage(failures, (key, params) => (key === "savedSql.nameConflict" ? `${params?.name} exists` : key), 2)).toBe("one.sql: one.sql exists; two.sql: write failed; … (+1)");
  });
});
