import { describe, expect, it } from "vitest";
import { isDirectNavigationTreeNode, objectSourceKindForTreeNode, objectSourceTargetForTreeNode, shouldActivateTreeNodeOnSingleClick, treeNodeRowAction, treeNodeRowDoubleClickAction } from "@/lib/sidebar/treeNodeClick";

describe("treeNodeClick", () => {
  it("opens synonym nodes as synonym source", () => {
    expect(objectSourceKindForTreeNode("synonym")).toBe("SYNONYM");
    expect(treeNodeRowAction("synonym", false)).toBe("open-source");
  });

  it("only Xugu type nodes open source on single click", () => {
    expect(treeNodeRowAction("type", false, "single", "xugu")).toBe("open-source");
    for (const dbType of ["postgres", "opengauss", "gaussdb", "kingbase", "vastbase"] as const) {
      expect(treeNodeRowAction("type", true, "single", dbType), String(dbType)).toBe("toggle");
      expect(treeNodeRowAction("type", false, "single", dbType), String(dbType)).toBe("none");
    }
    // Unknown connection type keeps the conservative no-action behavior.
    expect(treeNodeRowAction("type", false, "single", undefined)).toBe("none");
  });

  it("only Xugu type nodes open source on double click", () => {
    expect(treeNodeRowDoubleClickAction("type", false, "double", false, "xugu")).toBe("open-source");
    for (const dbType of ["postgres", "opengauss", "gaussdb", "kingbase", "vastbase"] as const) {
      expect(treeNodeRowDoubleClickAction("type", false, "double", true, dbType), String(dbType)).toBe("toggle");
      expect(treeNodeRowDoubleClickAction("type", false, "double", false, dbType), String(dbType)).toBe("none");
    }
    expect(treeNodeRowDoubleClickAction("type", false, "double", false, undefined)).toBe("none");
  });

  it("keeps source actions for non-type source nodes on PG-family databases", () => {
    for (const type of ["procedure", "function", "trigger", "sequence", "package", "package-body"] as const) {
      expect(treeNodeRowAction(type, false, "single", "postgres"), type).toBe("open-source");
    }
    expect(treeNodeRowAction("type-body", false, "single", "xugu")).toBe("open-source");
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

  it("toggles an expandable Xugu type node before opening its source", () => {
    expect(treeNodeRowAction("type", true, "single", "xugu")).toBe("toggle");
    expect(treeNodeRowAction("type", false, "single", "xugu")).toBe("open-source");
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
