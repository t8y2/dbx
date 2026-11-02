import { describe, expect, it } from "vitest";
import { firstSidebarSearchMatchDataNode, hasActiveSidebarSearch } from "@/lib/sidebar/sidebarSearchEnter";
import type { TreeNode } from "@/types/database";

function node(id: string, type: TreeNode["type"]): TreeNode {
  return {
    id,
    type,
    label: id,
    connectionId: "conn",
    database: "app",
    children: [],
    isExpanded: false,
  } as TreeNode;
}

describe("sidebar search Enter-to-open", () => {
  it("opens the first visible table-like node in tree order", () => {
    const nodes = [node("schema", "schema"), node("users", "table"), node("orders", "view"), node("billing", "materialized_view")];
    expect(firstSidebarSearchMatchDataNode(nodes, true)?.id).toBe("users");
  });

  it("returns null without table-like rows even when searching", () => {
    const nodes = [node("conn", "connection"), node("app", "database"), node("schema", "schema")];
    expect(firstSidebarSearchMatchDataNode(nodes, true)).toBeNull();
    expect(firstSidebarSearchMatchDataNode([], true)).toBeNull();
  });

  it("ignores the visible tree when no search is active", () => {
    const nodes = [node("users", "table")];
    expect(firstSidebarSearchMatchDataNode(nodes, false)).toBeNull();
  });

  it("treats the global query and per-database table searches as active search surfaces", () => {
    expect(hasActiveSidebarSearch("  users  ", {})).toBe(true);
    expect(hasActiveSidebarSearch("", { "conn:app": "users" })).toBe(true);
    expect(hasActiveSidebarSearch("", {})).toBe(false);
    expect(hasActiveSidebarSearch("   ", { "conn:app": "  " })).toBe(false);
  });
});
