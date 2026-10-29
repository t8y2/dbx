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

  it("sorts multiple root connection groups in ascending and descending order (#13738)", () => {
    const tree = [group("group-z", "Zeta Group", [connection("conn-1", "Conn 1")]), group("group-b", "Beta Group", [connection("conn-2", "Conn 2")]), group("group-a", "Alpha Group", [connection("conn-3", "Conn 3")])];

    const asc = sortConnectionListForDisplay(tree, "asc");
    expect(asc.map((node) => node.id)).toEqual(["group-a", "group-b", "group-z"]);

    const desc = sortConnectionListForDisplay(tree, "desc");
    expect(desc.map((node) => node.id)).toEqual(["group-z", "group-b", "group-a"]);
  });

  it("sorts newly created group into its alphabetical position (#13738)", () => {
    // When a new group is created, it is appended to the bottom in manual order.
    const initialTree = [group("group-prod", "Production", [connection("c-prod", "Prod")]), group("group-staging", "Staging", [connection("c-stg", "Staging")])];
    // Newly created group appended at the end
    const treeWithNewGroup = [...initialTree, group("group-dev", "Development", [connection("c-dev", "Dev")])];

    const sortedAsc = sortConnectionListForDisplay(treeWithNewGroup, "asc");
    expect(sortedAsc.map((node) => node.id)).toEqual(["group-dev", "group-prod", "group-staging"]);
  });

  it("sorts nested subgroups within a connection group (#13738)", () => {
    const tree = [group("parent", "Parent Group", [group("sub-z", "Sub Z", [connection("c-1", "Conn 1")]), group("sub-a", "Sub A", [connection("c-2", "Conn 2")])])];

    const sortedAsc = sortConnectionListForDisplay(tree, "asc");
    expect(sortedAsc[0]?.children?.map((node) => node.id)).toEqual(["sub-a", "sub-z"]);

    const sortedDesc = sortConnectionListForDisplay(tree, "desc");
    expect(sortedDesc[0]?.children?.map((node) => node.id)).toEqual(["sub-z", "sub-a"]);
  });

  it("projects configs with multiple groups ordered alphabetically (#13738)", () => {
    const connections = [{ id: "c-z" }, { id: "c-a" }];
    const tree = [group("group-z", "Zeta Group", [connection("c-z", "Z Conn")]), group("group-a", "Alpha Group", [connection("c-a", "A Conn")])];

    expect(orderConnectionsForSidebarDisplay(connections, tree, "asc").map((c) => c.id)).toEqual(["c-a", "c-z"]);
    expect(orderConnectionsForSidebarDisplay(connections, tree, "desc").map((c) => c.id)).toEqual(["c-z", "c-a"]);
  });
});
