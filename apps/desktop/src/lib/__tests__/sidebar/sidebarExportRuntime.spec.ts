import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { allDatabasesExportSourceForNode, databaseExportSourceForNode, sidebarStructureExportTargets } from "@/lib/sidebar/sidebarExportRuntime";

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
    const group: TreeNode = { id: "group", label: "Tables", type: "group-tables", children: [first, second] };

    expect(sidebarStructureExportTargets(first, [group], [first.id, second.id])).toEqual([first, second]);
    expect(sidebarStructureExportTargets(first, [group], [second.id])).toEqual([first]);
  });
});
