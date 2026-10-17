import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { sidebarNodeSupportsStructureEdit } from "@/lib/sidebar/sidebarTreeStructureShortcut";

function node(type: TreeNode["type"], extra: Partial<TreeNode> = {}): TreeNode {
  return { id: "n", label: "n", type, connectionId: "c", database: "db", ...extra };
}

describe("sidebar tree structure shortcut", () => {
  it("supports table nodes on databases that support table structure editing", () => {
    expect(sidebarNodeSupportsStructureEdit(node("table"), "mysql")).toBe(true);
    expect(sidebarNodeSupportsStructureEdit(node("table"), "postgres")).toBe(true);
    expect(sidebarNodeSupportsStructureEdit(node("table"), "redis")).toBe(false);
  });

  it("supports column and index nodes that have a tableName", () => {
    expect(sidebarNodeSupportsStructureEdit(node("column", { tableName: "users" }), "mysql")).toBe(true);
    expect(sidebarNodeSupportsStructureEdit(node("index", { tableName: "users" }), "mysql")).toBe(true);
    expect(sidebarNodeSupportsStructureEdit(node("column"), "mysql")).toBe(false);
    expect(sidebarNodeSupportsStructureEdit(node("index"), "mysql")).toBe(false);
  });

  it("rejects nodes without connection or database", () => {
    expect(sidebarNodeSupportsStructureEdit({ id: "n", label: "n", type: "table" }, "mysql")).toBe(false);
    expect(sidebarNodeSupportsStructureEdit({ id: "n", label: "n", type: "table", connectionId: "c" }, "mysql")).toBe(false);
  });

  it("rejects non-table nodes", () => {
    expect(sidebarNodeSupportsStructureEdit(node("connection"), "mysql")).toBe(false);
    expect(sidebarNodeSupportsStructureEdit(node("database"), "mysql")).toBe(false);
    expect(sidebarNodeSupportsStructureEdit(node("schema"), "mysql")).toBe(false);
    expect(sidebarNodeSupportsStructureEdit(node("procedure"), "mysql")).toBe(false);
    expect(sidebarNodeSupportsStructureEdit(node("view"), "mysql")).toBe(false);
  });

  it("rejects SQL Server linked server nodes", () => {
    expect(sidebarNodeSupportsStructureEdit(node("table", { linkedServer: "REMOTE" }), "sqlserver")).toBe(false);
  });
});
