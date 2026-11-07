import { describe, expect, it } from "vitest";
import { sidebarObjectNavigationNodes } from "@/lib/sidebar/sidebarUserAdminVisibility";
import type { TreeNode } from "@/types/database";

describe("sidebar utility visibility", () => {
  it("drops retired management groups from visible and hidden cached children without mutating the source", () => {
    const utility: TreeNode = { id: "entry", type: "connection-extensions", label: "tool", connectionId: "c1", children: [{ id: "child", type: "user-admin", label: "users", connectionId: "c1" }] };
    const nodes: TreeNode[] = [{ id: "c1", type: "connection", label: "connection", children: [utility], hiddenChildren: [utility] }];
    const result = sidebarObjectNavigationNodes(nodes);
    expect(result[0].children).toEqual([]);
    expect(result[0].hiddenChildren).toEqual([]);
    expect(nodes[0].children).toEqual([utility]);
  });

  it("strips saved-query shortcuts without modifying their original file nodes", () => {
    const file: TreeNode = { id: "file", type: "saved-sql-file", label: "Saved SQL", savedSqlId: "retained-file" };
    const nodes: TreeNode[] = [{ id: "DB", type: "database", label: "DB", children: [{ id: "queries", type: "saved-sql-root", label: "Queries", children: [file] }] }];
    expect(sidebarObjectNavigationNodes(nodes)[0].children).toEqual([]);
    expect(nodes[0].children![0].children).toEqual([file]);
    expect(file.savedSqlId).toBe("retained-file");
  });

  it("retains real PostgreSQL extensions, event triggers, tablespaces and Oracle object groups", () => {
    const nodes: TreeNode[] = ["group-extensions", "group-event-triggers", "group-tablespaces", "oracle-db-links", "native-job-group"].map((type) => ({ id: type, connectionId: "c1", type: type as TreeNode["type"], label: type }));
    expect(sidebarObjectNavigationNodes(nodes)).toBe(nodes);
  });

  it("removes old ungrouped management shortcuts while preserving adjacent objects", () => {
    const nodes: TreeNode[] = ["user-admin", "xugu-user-admin", "dameng-users", "dameng-roles", "dameng-job-admin", "database-job-admin", "process-list", "server-dashboard", "table"].map((type) => ({ id: type, type: type as TreeNode["type"], label: type }));
    expect(sidebarObjectNavigationNodes(nodes).map((node) => node.type)).toEqual(["table"]);
  });
});
