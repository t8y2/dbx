import { describe, expect, it } from "vitest";
import { isDirectNavigationTreeNode, objectSourceKindForTreeNode, shouldActivateTreeNodeOnSingleClick, treeNodeRowAction } from "@/lib/sidebar/treeNodeClick";

describe("treeNodeClick", () => {
  it("opens synonym nodes as synonym source", () => {
    expect(objectSourceKindForTreeNode("synonym")).toBe("SYNONYM");
    expect(treeNodeRowAction("synonym", false)).toBe("open-source");
  });

  it("opens Consul navigation entries on one click regardless of object activation preference", () => {
    expect(isDirectNavigationTreeNode("consul-root")).toBe(true);
    expect(isDirectNavigationTreeNode("consul-overview")).toBe(true);
    expect(isDirectNavigationTreeNode("table")).toBe(false);
    expect(shouldActivateTreeNodeOnSingleClick("consul-root", "double")).toBe(true);
    expect(shouldActivateTreeNodeOnSingleClick("consul-overview", "double")).toBe(true);
    expect(shouldActivateTreeNodeOnSingleClick("table", "double")).toBe(false);
    expect(treeNodeRowAction("consul-root", false, "double")).toBe("toggle");
    expect(treeNodeRowAction("consul-overview", false, "double")).toBe("toggle");
  });
});
