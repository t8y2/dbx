import { describe, expect, it } from "vitest";
import {
  isDirectNavigationTreeNode,
  isRepeatableNavigationTreeNode,
  objectSourceKindForTreeNode,
  objectSourceTargetForTreeNode,
  shouldActivateTreeNodeOnSingleClick,
  shouldBrowseObjectsOnDatabaseActivation,
  shouldRunTreeNodeRowAction,
  treeNodeRowAction,
  treeNodeRowDoubleClickAction,
} from "@/lib/sidebar/treeNodeClick";

describe("treeNodeClick", () => {
  it("opens DynamoDB tables in the document browser on single or double activation", () => {
    expect(treeNodeRowAction("dynamodb-table", false, "single", "dynamodb")).toBe("toggle");
    expect(treeNodeRowDoubleClickAction("dynamodb-table", false, "double", false, "dynamodb")).toBe("toggle");
  });

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

  it("opens Meilisearch system management as a direct leaf navigation entry", () => {
    expect(isDirectNavigationTreeNode("meilisearch-system")).toBe(true);
    expect(shouldActivateTreeNodeOnSingleClick("meilisearch-system", "double")).toBe(true);
    expect(treeNodeRowAction("meilisearch-system", false, "double")).toBe("toggle");
  });

  it("keeps Nacos namespace and access-control navigation responsive during rapid row switching", () => {
    for (const type of ["nacos-namespace", "nacos-access-control"] as const) {
      expect(isDirectNavigationTreeNode(type), type).toBe(true);
      expect(shouldActivateTreeNodeOnSingleClick(type, "double"), type).toBe(true);
      const action = treeNodeRowAction(type, false, "double");
      expect(action, type).toBe("toggle");
      expect(isRepeatableNavigationTreeNode(type), type).toBe(true);
      expect(shouldRunTreeNodeRowAction(action, 2, isRepeatableNavigationTreeNode(type)), type).toBe(true);
    }

    expect(isRepeatableNavigationTreeNode("database")).toBe(false);
    expect(shouldRunTreeNodeRowAction("toggle", 2, false)).toBe(false);
  });

  it("opens the connection database browser only when the capability is enabled", () => {
    expect(treeNodeRowDoubleClickAction("connection", false, "single", true, "postgres", true)).toBe("open-database-browser");
    expect(treeNodeRowDoubleClickAction("connection", false, "double", true, "postgres", false)).toBe("toggle");
  });

  it("expands the connection node on double-click activation even when the database browser is available", () => {
    expect(treeNodeRowDoubleClickAction("connection", false, "double", true, "postgres", true)).toBe("toggle");
    expect(treeNodeRowDoubleClickAction("connection", false, "double", true, "mysql", true)).toBe("toggle");
    expect(treeNodeRowDoubleClickAction("connection", false, "double", false, "postgres", true)).toBe("none");
  });

  it("browses objects on single-click activation only when enabled", () => {
    expect(treeNodeRowAction("database", true, "single", "postgres", true, true)).toBe("open-object-browser-and-expand");
    expect(treeNodeRowAction("database", false, "single", "postgres", true, true)).toBe("open-object-browser");
    expect(treeNodeRowAction("schema", true, "single", "postgres", true, true)).toBe("open-object-browser-and-expand");
    expect(treeNodeRowAction("database", true, "single", "postgres", false, true)).toBe("toggle");
    expect(treeNodeRowAction("schema", true, "single", "postgres", false, true)).toBe("toggle");
  });

  it("keeps the first click selection-only in double-click activation", () => {
    expect(treeNodeRowAction("database", true, "double", "postgres", true, true)).toBe("none");
    expect(treeNodeRowAction("schema", true, "double", "postgres", true, true)).toBe("none");
    expect(treeNodeRowAction("database", true, "double", "postgres", false, true)).toBe("none");
  });

  it("does not run a second database action after single-click activation", () => {
    expect(treeNodeRowDoubleClickAction("database", true, "single", true, "postgres", false, true)).toBe("none");
    expect(treeNodeRowDoubleClickAction("database", true, "single", true, "postgres", false, false)).toBe("none");
    expect(treeNodeRowDoubleClickAction("schema", true, "single", true, "postgres", false, true)).toBe("none");
  });

  it("browses objects on double-click activation only when enabled", () => {
    expect(treeNodeRowDoubleClickAction("database", true, "double", true, "postgres", false, true)).toBe("open-object-browser-and-expand");
    expect(treeNodeRowDoubleClickAction("schema", true, "double", false, "postgres", false, true)).toBe("open-object-browser");
    expect(treeNodeRowDoubleClickAction("database", true, "double", true, "postgres", false, false)).toBe("toggle");
    expect(treeNodeRowDoubleClickAction("schema", true, "double", false, "postgres", false, false)).toBe("none");
  });

  it("falls back to expansion when object browsing is unsupported", () => {
    expect(treeNodeRowAction("database", true, "single", "postgres", true, false)).toBe("toggle");
    expect(treeNodeRowAction("database", true, "double", "postgres", true, false)).toBe("none");
    expect(treeNodeRowDoubleClickAction("database", false, "double", true, "postgres", false, true)).toBe("toggle");
  });

  it("does not route non-database nodes through the database activation switch", () => {
    expect(treeNodeRowAction("table", false, "single", "postgres", true, true)).toBe("open-data");
    expect(treeNodeRowAction("table", false, "double", "postgres", true, true)).toBe("none");
    expect(shouldBrowseObjectsOnDatabaseActivation("table", true)).toBe(false);
    expect(shouldBrowseObjectsOnDatabaseActivation("database", true)).toBe(true);
    expect(shouldBrowseObjectsOnDatabaseActivation("database", false)).toBe(false);
    expect(shouldBrowseObjectsOnDatabaseActivation("mongo-db", true)).toBe(true);
    expect(shouldBrowseObjectsOnDatabaseActivation("object-browser", true)).toBe(false);
    expect(treeNodeRowDoubleClickAction("object-browser", true, "double", false, "postgres", false, false)).toBe("open-object-browser");
  });

  it("opens the MongoDB object browser from mongo-db nodes like SQL databases", () => {
    expect(treeNodeRowAction("mongo-db", true, "single", "mongodb", true, true)).toBe("open-object-browser-and-expand");
    expect(treeNodeRowAction("mongo-db", true, "single", "mongodb", false, true)).toBe("toggle");
    expect(treeNodeRowDoubleClickAction("mongo-db", true, "single", true, "mongodb", false, true)).toBe("none");
    expect(treeNodeRowDoubleClickAction("mongo-db", true, "double", true, "mongodb", false, true)).toBe("open-object-browser-and-expand");
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

  it("routes the package body action to the owning package source", () => {
    expect(
      objectSourceTargetForTreeNode({
        id: "pkg:body",
        label: "business_api",
        type: "package-body",
        objectName: "business_api",
        schema: "app_schema",
      }),
    ).toEqual({
      name: "business_api",
      schema: "app_schema",
      objectType: "PACKAGE_BODY",
      signature: undefined,
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
