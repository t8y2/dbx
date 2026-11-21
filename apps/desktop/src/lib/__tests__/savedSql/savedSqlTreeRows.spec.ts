import { describe, expect, it } from "vitest";
import { buildSavedSqlTreeRows } from "@/lib/savedSql/savedSqlTreeRows";
import type { SavedSqlFile, SavedSqlFolder } from "@/types/database";

function folder(overrides: Partial<SavedSqlFolder> & Pick<SavedSqlFolder, "id" | "name">): SavedSqlFolder {
  return {
    connectionId: "connection",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function file(overrides: Partial<SavedSqlFile> & Pick<SavedSqlFile, "id" | "name">): SavedSqlFile {
  return {
    connectionId: "connection",
    database: "database",
    sql: "select 1",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSavedSqlTreeRows", () => {
  it("keeps queries under their folder with the correct depth", () => {
    const rows = buildSavedSqlTreeRows([folder({ id: "reports", name: "Reports" })], [file({ id: "monthly", name: "monthly.sql", folderId: "reports" })], { mode: "folder" });

    expect(rows).toEqual([
      { type: "folder", folder: expect.objectContaining({ id: "reports" }), depth: 0 },
      { type: "file", file: expect.objectContaining({ id: "monthly" }), depth: 1 },
    ]);
  });

  it("keeps nested folders under their parent instead of promoting them", () => {
    const rows = buildSavedSqlTreeRows([folder({ id: "root", name: "Root" }), folder({ id: "child", name: "Child", parentFolderId: "root" }), folder({ id: "grandchild", name: "Grandchild", parentFolderId: "child" })], [file({ id: "nested", name: "nested.sql", folderId: "grandchild" })], {
      mode: "folder",
    });

    expect(rows.map((row) => [row.type, row.depth])).toEqual([
      ["folder", 0],
      ["folder", 1],
      ["folder", 2],
      ["file", 3],
    ]);
    expect(rows[2]).toMatchObject({ folder: { parentFolderId: "child" } });
  });

  it("sorts folders and files by updatedAt only among siblings in date mode", () => {
    const rootFolder = folder({ id: "root", name: "Root", updatedAt: "2024-01-01T00:00:00.000Z" });
    const childFolder = folder({ id: "child", name: "Child", parentFolderId: "root", updatedAt: "2024-01-03T00:00:00.000Z" });
    const childFile = file({ id: "child-file", name: "child.sql", folderId: "root", updatedAt: "2024-01-04T00:00:00.000Z" });
    const nestedFile = file({ id: "nested", name: "nested.sql", folderId: "child", updatedAt: "2024-01-02T00:00:00.000Z" });

    const rows = buildSavedSqlTreeRows([rootFolder, childFolder], [childFile, nestedFile], { mode: "date" });

    expect(rows.map((row) => (row.type === "folder" ? row.folder.id : row.file.id))).toEqual(["root", "child-file", "child", "nested"]);
  });

  it("uses names as a stable date tie-breaker", () => {
    const updatedAt = "2024-02-01T00:00:00.000Z";
    const rows = buildSavedSqlTreeRows([], [file({ id: "ten", name: "report10.sql", updatedAt }), file({ id: "two", name: "report2.sql", updatedAt })], { mode: "date" });

    expect(rows.map((row) => (row.type === "file" ? row.file.name : ""))).toEqual(["report2.sql", "report10.sql"]);
  });

  it("keeps folder-first orderIndex ordering in folder mode", () => {
    const rows = buildSavedSqlTreeRows(
      [folder({ id: "second", name: "Second", orderIndex: 2 }), folder({ id: "first", name: "First", orderIndex: 1 })],
      [file({ id: "newer", name: "newer.sql", orderIndex: 1, updatedAt: "2025-01-01T00:00:00.000Z" }), file({ id: "older", name: "older.sql", orderIndex: 2, updatedAt: "2020-01-01T00:00:00.000Z" })],
      { mode: "folder" },
    );

    expect(rows.map((row) => (row.type === "folder" ? row.folder.id : row.file.id))).toEqual(["first", "second", "newer", "older"]);
  });

  it("keeps root files and mixes them with root folders by date", () => {
    const rows = buildSavedSqlTreeRows(
      [folder({ id: "folder", name: "Folder", updatedAt: "2024-03-01T00:00:00.000Z" })],
      [file({ id: "root-file", name: "root.sql", updatedAt: "2024-03-02T00:00:00.000Z" }), file({ id: "nested-file", name: "nested.sql", folderId: "folder", updatedAt: "2024-03-03T00:00:00.000Z" })],
      { mode: "date" },
    );

    expect(
      rows.map((row) => ({
        id: row.type === "folder" ? row.folder.id : row.file.id,
        depth: row.depth,
      })),
    ).toEqual([
      { id: "root-file", depth: 0 },
      { id: "folder", depth: 0 },
      { id: "nested-file", depth: 1 },
    ]);
  });

  it("applies search and collapse only to visible rows without changing depths", () => {
    const folders = [folder({ id: "root", name: "Root" }), folder({ id: "child", name: "Child", parentFolderId: "root" }), folder({ id: "grandchild", name: "Grandchild", parentFolderId: "child" })];
    const files = [file({ id: "match", name: "monthly.sql", folderId: "grandchild" }), file({ id: "unmatched-root", name: "unrelated.sql" })];

    const searched = buildSavedSqlTreeRows(folders, files, {
      mode: "date",
      fileMatches: (candidate) => candidate.name.includes("monthly"),
    });
    expect(searched.map((row) => [row.type, row.depth])).toEqual([
      ["folder", 0],
      ["folder", 1],
      ["folder", 2],
      ["file", 3],
    ]);

    const collapsed = buildSavedSqlTreeRows(folders, files, {
      mode: "date",
      isFolderExpanded: (candidate) => candidate.id !== "child",
    });
    expect(collapsed.map((row) => (row.type === "folder" ? row.folder.id : row.file.id))).toEqual(["root", "child", "unmatched-root"]);
    expect(collapsed.map((row) => row.depth)).toEqual([0, 1, 0]);
  });
});
