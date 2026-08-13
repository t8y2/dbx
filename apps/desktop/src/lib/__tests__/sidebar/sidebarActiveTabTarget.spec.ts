import { describe, expect, it } from "vitest";
import { activeTabSidebarTarget, matchesTarget } from "@/lib/sidebar/sidebarActiveTabTarget";
import type { QueryTab, TreeNode } from "@/types/database";

describe("sidebar active-tab targets", () => {
  it("selects the connection node for a database-browser tab", () => {
    const target = activeTabSidebarTarget({ mode: "databases", connectionId: "pg-1" } as QueryTab);

    expect(target).toEqual({ type: "connection", connectionId: "pg-1" });
    expect(matchesTarget({ id: "connection:pg-1", label: "Postgres", type: "connection", connectionId: "pg-1" } as TreeNode, target!)).toBe(true);
    expect(matchesTarget({ id: "connection:pg-2", label: "Other", type: "connection", connectionId: "pg-2" } as TreeNode, target!)).toBe(false);
  });

  it("locates a query context only in its exact catalog", () => {
    const target = activeTabSidebarTarget({ mode: "query", connectionId: "doris-1", catalog: "hive", database: "analytics" } as QueryTab);
    const hiveDatabase = { id: "hive:analytics", label: "analytics", type: "database", connectionId: "doris-1", catalog: "hive", database: "analytics" } as TreeNode;
    const icebergDatabase = { ...hiveDatabase, id: "iceberg:analytics", catalog: "iceberg" };
    const defaultDatabase = { ...hiveDatabase, id: "default:analytics", catalog: undefined };

    expect(matchesTarget(hiveDatabase, target!)).toBe(true);
    expect(matchesTarget(icebergDatabase, target!)).toBe(false);
    expect(matchesTarget(defaultDatabase, target!)).toBe(false);
  });
});
