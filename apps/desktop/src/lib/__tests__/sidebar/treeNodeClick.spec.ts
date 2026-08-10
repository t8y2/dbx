import { describe, expect, it } from "vitest";
import { isDirectNavigationTreeNode, objectSourceKindForTreeNode, objectSourceTargetForTreeNode, shouldActivateTreeNodeOnSingleClick, treeNodeRowAction } from "@/lib/sidebar/treeNodeClick";

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

  it("expands package containers while preserving source behavior for leaf packages", () => {
    expect(treeNodeRowAction("package", true)).toBe("toggle");
    expect(treeNodeRowAction("package", false)).toBe("open-source");
  });

  it("toggles an expandable type node before opening its source", () => {
    expect(treeNodeRowAction("type", true)).toBe("toggle");
    expect(treeNodeRowAction("type", false)).toBe("open-source");
  });

  it("routes package members to their owning package body", () => {
    expect(
      objectSourceTargetForTreeNode({
        id: "pkg:member",
        label: "calculate(p_value IN INT)",
        type: "function",
        objectName: "calculate",
        parentName: "business_api",
        parentSchema: "app_schema",
        parentType: "package",
        schema: "ignored_schema",
        signature: "p_value IN INT",
      }),
    ).toEqual({
      name: "business_api",
      schema: "app_schema",
      objectType: "PACKAGE",
      signature: "p_value IN INT",
    });
  });

  it("keeps standalone routine source routing unchanged", () => {
    expect(objectSourceTargetForTreeNode({ id: "proc", label: "standalone_proc", type: "procedure", schema: "app" })).toEqual({
      name: "standalone_proc",
      schema: "app",
      objectType: "PROCEDURE",
      signature: undefined,
    });
  });

  it("does not reinterpret unrelated parent metadata as a package member", () => {
    expect(objectSourceTargetForTreeNode({ id: "routine", label: "child_routine", type: "function", schema: "app", parentName: "other_parent" })).toEqual({
      name: "child_routine",
      schema: "app",
      objectType: "FUNCTION",
      signature: undefined,
    });
  });
});
