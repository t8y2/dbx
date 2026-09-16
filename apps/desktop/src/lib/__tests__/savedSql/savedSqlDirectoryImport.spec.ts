import { describe, expect, it } from "vitest";
import { collectSavedSqlDirectoryImportFiles } from "@/lib/savedSql/savedSqlDirectoryImport";

describe("saved SQL directory import", () => {
  it("preserves nested directory paths without flattening file names", () => {
    const files = collectSavedSqlDirectoryImportFiles([
      { name: "database", path: "/scripts/database", is_dir: true, children: [{ name: "daily.sql", path: "/scripts/database/daily.sql", is_dir: false, children: [] }] },
      {
        name: "incidents",
        path: "/scripts/incidents",
        is_dir: true,
        children: [
          {
            name: "postgres",
            path: "/scripts/incidents/postgres",
            is_dir: true,
            children: [{ name: "repair.sql", path: "/scripts/incidents/postgres/repair.sql", is_dir: false, children: [] }],
          },
        ],
      },
      { name: "root.sql", path: "/scripts/root.sql", is_dir: false, children: [] },
    ]);

    expect(files).toEqual([
      { name: "daily.sql", path: "/scripts/database/daily.sql", folderNames: ["database"] },
      { name: "repair.sql", path: "/scripts/incidents/postgres/repair.sql", folderNames: ["incidents", "postgres"] },
      { name: "root.sql", path: "/scripts/root.sql", folderNames: [] },
    ]);
  });
});
