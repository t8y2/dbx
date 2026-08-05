import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { sidebarNodeSupportsDdlView } from "@/lib/sidebar/sidebarTreeDdlShortcut";

function node(type: TreeNode["type"]): TreeNode {
  return { id: "n", label: "n", type, connectionId: "c", database: "db" };
}

describe("sidebar tree DDL shortcut", () => {
  it("supports table, view and materialized view nodes", () => {
    expect(sidebarNodeSupportsDdlView(node("table"))).toBe(true);
    expect(sidebarNodeSupportsDdlView(node("view"))).toBe(true);
    expect(sidebarNodeSupportsDdlView(node("materialized_view"))).toBe(true);
  });

  it("rejects nodes without a DDL view", () => {
    expect(sidebarNodeSupportsDdlView(node("connection"))).toBe(false);
    expect(sidebarNodeSupportsDdlView(node("database"))).toBe(false);
    expect(sidebarNodeSupportsDdlView(node("schema"))).toBe(false);
    expect(sidebarNodeSupportsDdlView(node("column"))).toBe(false);
    expect(sidebarNodeSupportsDdlView(node("index"))).toBe(false);
    expect(sidebarNodeSupportsDdlView(node("procedure"))).toBe(false);
    expect(sidebarNodeSupportsDdlView(node("group"))).toBe(false);
  });
});
