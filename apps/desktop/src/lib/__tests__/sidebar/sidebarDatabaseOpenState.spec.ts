import { describe, expect, it } from "vitest";
import { isSidebarDatabaseOpenForVisual, sidebarDatabaseOpenKey } from "@/lib/sidebar/sidebarDatabaseOpenState";
import type { TreeNode } from "@/types/database";

function databaseNode(id: string, connectionId: string, database: string): TreeNode {
  return {
    id,
    label: database,
    type: "database",
    connectionId,
    database,
  };
}

describe("isSidebarDatabaseOpenForVisual", () => {
  it("treats open editor tabs as open even before sidebar children are loaded", () => {
    const node = databaseNode("db-node", "conn-1", "test1");
    const openKeys = new Set([sidebarDatabaseOpenKey("conn-1", "test1")]);

    expect(isSidebarDatabaseOpenForVisual(node, () => false, openKeys)).toBe(true);
  });

  it("stays closed when neither loaded nor referenced by an open tab", () => {
    const node = databaseNode("db-node", "conn-1", "test1");

    expect(isSidebarDatabaseOpenForVisual(node, () => false, new Set())).toBe(false);
  });
});
