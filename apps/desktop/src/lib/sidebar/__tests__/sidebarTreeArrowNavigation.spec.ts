import { describe, expect, it } from "vitest";
import { flattenTree } from "@/composables/useFlatTree";
import type { TreeNode, TreeNodeType } from "@/types/database";
import { sidebarTreeArrowAction } from "@/lib/sidebar/sidebarTreeArrowNavigation";

function node(id: string, type: TreeNodeType, children: TreeNode[] = [], isExpanded = false): TreeNode {
  return { id, label: id, type, children, isExpanded };
}

function buildRows(): ReturnType<typeof flattenTree> {
  const tree = [node("conn1", "connection"), node("conn2", "connection", [node("db1", "database", [node("group-tables", "group-tables", [node("t1", "table"), node("t2", "table")], true), node("group-views", "group-views")], true), node("db2", "database")], true), node("conn3", "connection")];
  return flattenTree(tree);
}

// Visible order: conn1, conn2, db1, group-tables, t1, t2, group-views, db2, conn3.
describe("sidebar tree arrow navigation", () => {
  it("ArrowDown selects the next visible row", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "conn1", "ArrowDown")).toEqual({ kind: "select", nodeId: "conn2" });
    expect(sidebarTreeArrowAction(rows, "t1", "ArrowDown")).toEqual({ kind: "select", nodeId: "t2" });
  });

  it("ArrowUp selects the previous visible row", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "t2", "ArrowUp")).toEqual({ kind: "select", nodeId: "t1" });
    expect(sidebarTreeArrowAction(rows, "group-views", "ArrowUp")).toEqual({ kind: "select", nodeId: "t2" });
  });

  it("ArrowUp on the first row and ArrowDown on the last row do nothing", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "conn1", "ArrowUp")).toEqual({ kind: "none" });
    expect(sidebarTreeArrowAction(rows, "conn3", "ArrowDown")).toEqual({ kind: "none" });
  });

  it("ArrowRight expands a collapsed expandable node", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "conn1", "ArrowRight")).toEqual({ kind: "toggle", nodeId: "conn1", expanded: true });
  });

  it("ArrowRight expands a collapsed container whose children are not loaded yet", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "db2", "ArrowRight")).toEqual({ kind: "toggle", nodeId: "db2", expanded: true });
  });

  it("ArrowRight on an expanded node selects its first child", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "group-tables", "ArrowRight")).toEqual({ kind: "select", nodeId: "t1" });
  });

  it("ArrowRight on a collapsed table expands it (column/index groups load on demand)", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "t1", "ArrowRight")).toEqual({ kind: "toggle", nodeId: "t1", expanded: true });
  });

  it("ArrowRight on a leaf does nothing", () => {
    const rows = flattenTree([node("tbl", "table", [node("col1", "column")], true)]);
    expect(sidebarTreeArrowAction(rows, "col1", "ArrowRight")).toEqual({ kind: "none" });
  });

  it("ArrowLeft collapses an expanded node", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "group-tables", "ArrowLeft")).toEqual({ kind: "toggle", nodeId: "group-tables", expanded: false });
    expect(sidebarTreeArrowAction(rows, "conn2", "ArrowLeft")).toEqual({ kind: "toggle", nodeId: "conn2", expanded: false });
  });

  it("ArrowLeft on a leaf selects its parent", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "t1", "ArrowLeft")).toEqual({ kind: "select", nodeId: "group-tables" });
  });

  it("ArrowLeft on a collapsed container selects its parent", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "group-views", "ArrowLeft")).toEqual({ kind: "select", nodeId: "db1" });
  });

  it("ArrowLeft on a collapsed root does nothing", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "conn1", "ArrowLeft")).toEqual({ kind: "none" });
  });

  it("ignores unknown keys and unknown node ids", () => {
    const rows = buildRows();
    expect(sidebarTreeArrowAction(rows, "t1", "PageDown")).toEqual({ kind: "none" });
    expect(sidebarTreeArrowAction(rows, "missing", "ArrowDown")).toEqual({ kind: "none" });
  });

  it("ArrowRight does not expand a PostgreSQL-family custom type without members", () => {
    const typeNode: TreeNode = { ...node("t1", "type", [node("m1", "type-attributes")]), hasMembers: false };
    const rows = flattenTree([typeNode]);
    expect(sidebarTreeArrowAction(rows, "t1", "ArrowRight", { databaseType: "postgres" })).toEqual({ kind: "none" });
  });

  it("ArrowRight expands a custom type that has members", () => {
    const typeNode: TreeNode = { ...node("t1", "type", [node("m1", "type-attributes")]), hasMembers: true };
    const rows = flattenTree([typeNode]);
    expect(sidebarTreeArrowAction(rows, "t1", "ArrowRight", { databaseType: "postgres" })).toEqual({ kind: "toggle", nodeId: "t1", expanded: true });
  });

  it("the member gate only applies to custom-type databases", () => {
    const typeNode: TreeNode = { ...node("t1", "type", [node("m1", "type-attributes")]), hasMembers: false };
    const rows = flattenTree([typeNode]);
    expect(sidebarTreeArrowAction(rows, "t1", "ArrowRight", { databaseType: "mysql" })).toEqual({ kind: "toggle", nodeId: "t1", expanded: true });
    const plainRows = buildRows();
    expect(sidebarTreeArrowAction(plainRows, "conn1", "ArrowRight", { databaseType: "postgres" })).toEqual({ kind: "toggle", nodeId: "conn1", expanded: true });
  });

  it("ArrowLeft still collapses an expanded custom type without members", () => {
    const typeNode: TreeNode = { ...node("t1", "type", [node("m1", "type-attributes")], true), hasMembers: false };
    const rows = flattenTree([typeNode]);
    expect(sidebarTreeArrowAction(rows, "t1", "ArrowLeft", { databaseType: "postgres" })).toEqual({ kind: "toggle", nodeId: "t1", expanded: false });
  });
});
