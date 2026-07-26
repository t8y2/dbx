import { describe, expect, it } from "vitest";
import { simpleModeEmptyShellNeedsConfirmedLoad, treeNodeLoadedChildrenContentPresent } from "@/lib/sidebar/treeLoadedChildrenMarker";
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

describe("simpleModeEmptyShellNeedsConfirmedLoad", () => {
  it("requires confirmed empty only for simple database/schema shells", () => {
    const db = databaseNode();
    expect(simpleModeEmptyShellNeedsConfirmedLoad(db, "simple")).toBe(true);
    expect(simpleModeEmptyShellNeedsConfirmedLoad(db, "grouped")).toBe(false);
    expect(simpleModeEmptyShellNeedsConfirmedLoad(databaseNode([{ id: "x", label: "t", type: "table", connectionId: "conn", database: "test1" }]), "simple")).toBe(false);
  });
});

describe("linked-server-schema empty shell", () => {
  function linkedSchemaNode(children: TreeNode[] = []): TreeNode {
    return {
      id: "conn:linkeddb:dbo",
      label: "dbo",
      type: "linked-server-schema",
      connectionId: "conn",
      database: "linkeddb",
      schema: "dbo",
      isExpanded: false,
      children,
    };
  }

  it("treats an empty grouped linked-server-schema shell as missing loaded content", () => {
    expect(treeNodeLoadedChildrenContentPresent(linkedSchemaNode(), "grouped")).toBe(false);
  });

  it("accepts simple-mode linked-server-schema with no objects as a valid empty load candidate", () => {
    expect(treeNodeLoadedChildrenContentPresent(linkedSchemaNode(), "simple")).toBe(true);
  });
});
