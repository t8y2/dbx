import { describe, expect, it } from "vitest";
import { filterSidebarModifierSelectionIds, selectedSidebarBatchTargets, supportsSidebarModifierSelection } from "@/lib/sidebar/sidebarTreeSelection";
import type { TreeNode } from "@/types/database";

function node(id: string, type: TreeNode["type"]): TreeNode {
  return { id, label: id, type };
}

describe("sidebar modifier selection", () => {
  it("disables modifier selection for database, schema, and object-group nodes", () => {
    expect(supportsSidebarModifierSelection(node("database-1", "database"))).toBe(false);
    expect(supportsSidebarModifierSelection(node("schema-1", "schema"))).toBe(false);
    expect(supportsSidebarModifierSelection(node("tables-1", "group-tables"))).toBe(false);
    expect(supportsSidebarModifierSelection(node("views-1", "group-views"))).toBe(false);
  });

  it("keeps nodes with existing connection and object bulk actions selectable", () => {
    expect(supportsSidebarModifierSelection(node("connection-1", "connection"))).toBe(true);
    expect(supportsSidebarModifierSelection(node("table-1", "table"))).toBe(true);
    expect(supportsSidebarModifierSelection(node("index-1", "index"))).toBe(true);
  });

  it("excludes containers reached indirectly by a modifier selection", () => {
    const nodes = [node("tables-1", "group-tables"), node("table-1", "table"), node("schema-1", "schema"), node("database-1", "database"), node("table-2", "table")];

    expect(
      filterSidebarModifierSelectionIds(
        nodes,
        nodes.map((item) => item.id),
      ),
    ).toEqual(["table-1", "table-2"]);
  });
});

describe("sidebar batch action targets", () => {
  const table = (id: string, connectionId = "connection-1", database = "database-1"): TreeNode => ({
    id,
    label: id,
    type: "table",
    connectionId,
    database,
  });

  it("keeps selected tables from the same database when the context target is selected", () => {
    const first = table("table-1");
    const second = table("table-2");

    expect(selectedSidebarBatchTargets(second, [first, second], () => true)).toEqual([first, second]);
  });

  it("rejects stale, cross-database, and unsupported selections", () => {
    const first = table("table-1");
    const second = table("table-2");

    expect(selectedSidebarBatchTargets(table("outside"), [first, second], () => true)).toEqual([]);
    expect(selectedSidebarBatchTargets(second, [first, table("other", "connection-1", "database-2")], () => true)).toEqual([]);
    expect(selectedSidebarBatchTargets(second, [first, second], (target) => target.id !== second.id)).toEqual([]);
  });
});
