import { describe, expect, it } from "vitest";
import { treeNodeLoadedChildrenContentPresent } from "@/lib/sidebar/treeLoadedChildrenMarker";
import type { TreeNode } from "@/types/database";

function databaseNode(children: TreeNode[] = []): TreeNode {
  return {
    id: "conn:test1",
    label: "test1",
    type: "database",
    connectionId: "conn",
    database: "test1",
    isExpanded: false,
    children,
  };
}

describe("treeNodeLoadedChildrenContentPresent", () => {
  it("treats an empty grouped database shell as missing loaded content", () => {
    expect(treeNodeLoadedChildrenContentPresent(databaseNode(), "grouped")).toBe(false);
  });

  it("accepts grouped databases with object-group placeholders", () => {
    const node = databaseNode([
      {
        id: "conn:test1:__tables",
        label: "Tables",
        type: "group-tables",
        connectionId: "conn",
        database: "test1",
        isExpanded: false,
        children: [],
      },
    ]);
    expect(treeNodeLoadedChildrenContentPresent(node, "grouped")).toBe(true);
  });

  it("accepts simple-mode databases with no objects as a valid empty load", () => {
    expect(treeNodeLoadedChildrenContentPresent(databaseNode(), "simple")).toBe(true);
  });

  it("accepts loaded object groups with zero items", () => {
    const node: TreeNode = {
      id: "conn:test1:__tables",
      label: "Tables",
      type: "group-tables",
      connectionId: "conn",
      database: "test1",
      isExpanded: false,
      children: [],
    };
    expect(treeNodeLoadedChildrenContentPresent(node, "grouped")).toBe(true);
  });
});
