import { describe, expect, it } from "vitest";
import { savedSqlFolderBranchFileCount, type SavedSqlFolderCountNode } from "../savedSqlFolderCounts";

describe("savedSqlFolderBranchFileCount", () => {
  const folders: SavedSqlFolderCountNode[] = [{ id: "root" }, { id: "child", parentFolderId: "root" }, { id: "grandchild", parentFolderId: "child" }, { id: "sibling", parentFolderId: "root" }, { id: "other" }];
  const filesByFolder = new Map<string, unknown[]>([
    ["root", ["root.sql"]],
    ["child", []],
    ["grandchild", ["nested.sql", "report.sql"]],
    ["sibling", ["side.sql"]],
    ["other", ["other.sql"]],
  ]);

  it("counts files in descendant folders", () => {
    const count = savedSqlFolderBranchFileCount("root", folders, (folderId) => filesByFolder.get(folderId) ?? []);

    expect(count).toBe(4);
  });

  it("does not count files outside the folder branch", () => {
    const count = savedSqlFolderBranchFileCount("child", folders, (folderId) => filesByFolder.get(folderId) ?? []);

    expect(count).toBe(2);
  });

  it("does not loop on cyclic folder data", () => {
    const cyclicFolders: SavedSqlFolderCountNode[] = [
      { id: "a", parentFolderId: "b" },
      { id: "b", parentFolderId: "a" },
    ];

    const count = savedSqlFolderBranchFileCount("a", cyclicFolders, () => ["file.sql"]);

    expect(count).toBe(2);
  });
});
