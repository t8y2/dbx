import { describe, expect, it } from "vitest";
import { orderConnectionsForSidebarDisplay, sortConnectionListForDisplay } from "@/lib/sidebar/connectionListSort";
import type { TreeNode } from "@/types/database";

function connection(id: string, label: string): TreeNode {
  return { id, label, type: "connection", connectionId: id, children: [] };
}

function group(id: string, label: string, children: TreeNode[]): TreeNode {
  return { id, label, type: "connection-group", isExpanded: true, children };
}

describe("connection list display sort", () => {
  const manualTree = [connection("zebra", "zebra"), group("team", "Team databases", [connection("beta", "Beta"), connection("alpha", "alpha"), connection("alpha-two", "Alpha 2")]), connection("alpha-root", "Alpha"), connection("alpha-root-two", "alpha")];

  it("sorts root and grouped connections in ascending name order while preserving group placement", () => {
    const sorted = sortConnectionListForDisplay(manualTree, "asc");

    expect(sorted.map((node) => node.id)).toEqual(["alpha-root", "team", "alpha-root-two", "zebra"]);
    expect(sorted[1]?.children?.map((node) => node.id)).toEqual(["alpha", "alpha-two", "beta"]);
  });

  it("sorts root and grouped connections in descending name order", () => {
    const sorted = sortConnectionListForDisplay(manualTree, "desc");

    expect(sorted.map((node) => node.id)).toEqual(["zebra", "team", "alpha-root", "alpha-root-two"]);
    expect(sorted[1]?.children?.map((node) => node.id)).toEqual(["beta", "alpha-two", "alpha"]);
  });

  it("keeps manual order and stored tree references untouched", () => {
    const manual = sortConnectionListForDisplay(manualTree, "manual");
    const sorted = sortConnectionListForDisplay(manualTree, "asc");

    expect(manual).toBe(manualTree);
    expect(manualTree.map((node) => node.id)).toEqual(["zebra", "team", "alpha-root", "alpha-root-two"]);
    expect(manualTree[1]?.children?.map((node) => node.id)).toEqual(["beta", "alpha", "alpha-two"]);
    expect(sorted[1]).not.toBe(manualTree[1]);
  });

  it("flattens nested manual order, appends missing connections, and removes duplicates", () => {
    const connections = [{ id: "alpha" }, { id: "beta" }, { id: "zebra" }, { id: "new" }];
    const tree = [connection("zebra", "Zebra"), group("parent", "Parent", [connection("beta", "Beta"), group("nested", "Nested", [connection("alpha", "Alpha"), connection("zebra", "Zebra duplicate")])])];

    expect(orderConnectionsForSidebarDisplay(connections, tree, "manual").map((connection) => connection.id)).toEqual(["zebra", "beta", "alpha", "new"]);
  });

  it("projects configs through the sidebar's alphabetical display mode", () => {
    const connections = [{ id: "zebra" }, { id: "alpha" }, { id: "beta" }];
    const tree = [group("parent", "Parent", [connection("zebra", "Zebra"), group("nested", "Nested", [connection("beta", "Beta")]), connection("alpha", "Alpha")])];

    expect(orderConnectionsForSidebarDisplay(connections, tree, "asc").map((connection) => connection.id)).toEqual(["alpha", "beta", "zebra"]);
  });
});
