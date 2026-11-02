import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { allDatabasesExportSourceForNode, databaseExportSourceForNode, sidebarSameSchemaStructureTargets, sidebarStructureExportTargets, sidebarTableDataExportTargets } from "@/lib/sidebar/sidebarExportRuntime";

describe("sidebar export runtime", () => {
  it("prepares database and table export sources", () => {
    expect(databaseExportSourceForNode({ id: "schema", label: "public", type: "schema", connectionId: "c1", database: "db", schema: "public" })).toEqual({
      connectionId: "c1",
      database: "db",
      schema: "public",
    });
    expect(databaseExportSourceForNode({ id: "table", label: "users", type: "table", connectionId: "c1", database: "db", schema: "public" })).toEqual({
      connectionId: "c1",
      database: "db",
      schema: "public",
      tableName: "users",
    });
    expect(allDatabasesExportSourceForNode({ id: "c1", label: "Connection", type: "connection", connectionId: "c1" })).toEqual({ connectionId: "c1", database: "", allDatabases: true });
  });

  it("freezes the accepted structure selection before export work starts", () => {
    const first: TreeNode = { id: "t1", label: "one", type: "table", connectionId: "c1", database: "db" };
    const second: TreeNode = { id: "t2", label: "two", type: "view", connectionId: "c1", database: "db" };
    const third: TreeNode = { id: "t3", label: "three", type: "materialized_view", connectionId: "c1", database: "db" };
    const group: TreeNode = { id: "group", label: "Tables", type: "group-tables", children: [first, second, third] };

    expect(sidebarStructureExportTargets(first, [group], [third.id, first.id, second.id])).toEqual([first, second, third]);
    expect(sidebarStructureExportTargets(first, [group], [second.id])).toEqual([first]);
  });

  it("limits multi-select diagram and database export prefills to the active schema context", () => {
    const publicUsers: TreeNode = { id: "t1", label: "users", type: "table", connectionId: "c1", database: "db", schema: "public" };
    const publicOrders: TreeNode = { id: "t2", label: "orders", type: "table", connectionId: "c1", database: "db", schema: "public" };
    const salesUsers: TreeNode = { id: "t3", label: "users", type: "table", connectionId: "c1", database: "db", schema: "sales" };
    const group: TreeNode = { id: "group", label: "Tables", type: "group-tables", children: [publicUsers, publicOrders, salesUsers] };

    expect(sidebarSameSchemaStructureTargets(publicUsers, [group], [publicOrders.id, publicUsers.id, salesUsers.id])).toEqual([publicUsers, publicOrders]);
    expect(sidebarSameSchemaStructureTargets(publicUsers, [group], [salesUsers.id, publicUsers.id])).toEqual([publicUsers]);
  });

  it("counts batch data export targets as tables only", () => {
    const table: TreeNode = { id: "t1", label: "users", type: "table", connectionId: "c1", database: "db", schema: "public" };
    const view: TreeNode = { id: "v1", label: "active_users", type: "view", connectionId: "c1", database: "db", schema: "public" };
    const other: TreeNode = { id: "t2", label: "orders", type: "table", connectionId: "c1", database: "db", schema: "public" };
    const group: TreeNode = { id: "group", label: "Objects", type: "group-tables", children: [table, view, other] };

    expect(sidebarTableDataExportTargets(table, [group], [other.id, table.id, view.id])).toEqual([table, other]);
    expect(sidebarTableDataExportTargets(view, [group], [other.id, table.id, view.id])).toEqual([view]);
    expect(sidebarTableDataExportTargets(table, [group], [view.id])).toEqual([table]);
  });

  it("scopes batch data export targets to the active execution context", () => {
    const localUsers: TreeNode = { id: "t1", label: "users", type: "table", connectionId: "c1", database: "db", schema: "public" };
    const localOrders: TreeNode = { id: "t2", label: "orders", type: "table", connectionId: "c1", database: "db", schema: "public" };
    const otherConnectionOrders: TreeNode = { id: "t3", label: "orders", type: "table", connectionId: "c2", database: "db", schema: "public" };
    const otherDatabaseUsers: TreeNode = { id: "t4", label: "users", type: "table", connectionId: "c1", database: "other", schema: "public" };
    const group: TreeNode = { id: "group", label: "Tables", type: "group-tables", children: [localUsers, localOrders, otherConnectionOrders, otherDatabaseUsers] };

    expect(sidebarTableDataExportTargets(localUsers, [group], [localUsers.id, localOrders.id, otherConnectionOrders.id, otherDatabaseUsers.id])).toEqual([localUsers, localOrders]);
    expect(sidebarTableDataExportTargets(localOrders, [group], [localUsers.id, localOrders.id, otherConnectionOrders.id, otherDatabaseUsers.id])).toEqual([localUsers, localOrders]);
  });
});
