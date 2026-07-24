import { describe, expect, it } from "vitest";
import { filterSidebarTreeToConnectedConnections } from "@/lib/sidebar/sidebarSearchTree";
import type { TreeNode } from "@/types/database";

function connection(id: string): TreeNode {
  return {
    id,
    label: id,
    type: "connection",
    connectionId: id,
    isExpanded: true,
    children: [{ id: `${id}:database`, label: "database", type: "database", connectionId: id }],
  };
}

function group(id: string, children: TreeNode[]): TreeNode {
  return { id, label: id, type: "connection-group", isExpanded: true, children };
}

describe("connected sidebar connection filter", () => {
  it("keeps connected connections and their nested groups while removing disconnected connections and empty groups", () => {
    const connected = connection("connected");
    const tree = [connection("disconnected"), group("team", [group("production", [connected]), group("inactive", [connection("other")])])];

    const result = filterSidebarTreeToConnectedConnections(tree, new Set(["connected"]));

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("team");
    expect(result[0]?.children?.[0]?.id).toBe("production");
    expect(result[0]?.children?.[0]?.children?.[0]).toBe(connected);
    expect(result[0]?.children?.some((node) => node.id === "inactive")).toBe(false);
  });

  it("preserves the existing tree when every displayed connection is active", () => {
    const first = connection("first");
    const tree = [group("team", [first])];

    expect(filterSidebarTreeToConnectedConnections(tree, new Set(["first"]))).toBe(tree);
  });
});
