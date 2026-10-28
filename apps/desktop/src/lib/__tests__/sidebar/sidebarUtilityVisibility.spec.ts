import { describe, expect, it } from "vitest";
import { sidebarUserAdminVisibility } from "@/lib/sidebar/sidebarUserAdminVisibility";
import type { ConnectionConfig, TreeNode } from "@/types/database";

describe("sidebar utility visibility", () => {
  const entries = [
    ["oracle-db-links", "show_database_links"],
    ["database-job-admin", "show_native_jobs"],
    ["dameng-job-admin", "show_native_jobs"],
    ["user-admin", "show_user_admin"],
    ["xugu-user-admin", "show_user_admin"],
  ] as const;

  it.each(entries)("applies %s connection opt-outs without mutating the live tree", (type, field) => {
    for (const override of [undefined, false, true]) {
      const utility: TreeNode = { id: "entry", type, label: "tool", connectionId: "c1", children: [{ id: "child", type: "oracle-db-link", label: "link", connectionId: "c1" }] };
      const nodes: TreeNode[] = [{ id: "c1", type: "connection", label: "connection", children: [utility], hiddenChildren: [utility] }];
      const config = { id: "c1", [field]: override } as ConnectionConfig;
      const result = sidebarUserAdminVisibility(nodes, () => config);
      const visible = override !== false;
      expect(result.nodes[0].children).toHaveLength(visible ? 1 : 0);
      expect(result.nodes[0].hiddenChildren).toHaveLength(visible ? 1 : 0);
      expect(result.hiddenNodeIds.has("entry")).toBe(!visible);
      expect(result.hiddenNodeIds.has("child")).toBe(!visible);
      expect(nodes[0].children).toEqual([utility]);
      const restored = sidebarUserAdminVisibility(nodes, () => undefined);
      expect(restored.nodes).toBe(nodes);
    }
  });

  it("keeps opt-outs scoped to their connection", () => {
    const nodes: TreeNode[] = ["c1", "c2"].map((connectionId) => ({ id: connectionId, connectionId, type: "database-job-admin", label: "jobs" }));
    const result = sidebarUserAdminVisibility(nodes, (id) => ({ id, show_native_jobs: id === "c1" ? false : undefined }) as ConnectionConfig);
    expect(result.nodes.map((node) => node.id)).toEqual(["c2"]);
  });
});
