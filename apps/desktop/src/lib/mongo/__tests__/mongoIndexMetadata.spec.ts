import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/types/database";
import { findLoadedMongoIndexesGroup, refreshLoadedMongoIndexes } from "../mongoIndexMetadata";

const scope = { connectionId: "conn-1", database: "app", collection: "users" };

function indexesGroup(isExpanded = false): TreeNode {
  return {
    id: "conn-1:app:users:__indexes",
    label: "tree.indexes",
    type: "group-indexes",
    connectionId: "conn-1",
    database: "app",
    tableName: "users",
    isExpanded,
    children: [],
  };
}

describe("Mongo index metadata refresh", () => {
  it("finds groups retained under hidden tree children", () => {
    const group = indexesGroup();
    const root = { id: "root", label: "root", type: "connection", hiddenChildren: [group] } as TreeNode;

    expect(findLoadedMongoIndexesGroup([root], scope)).toBe(group);
  });

  it("refreshes a loaded group without expanding a collapsed tree node", async () => {
    const group = indexesGroup(false);
    const loadIndexes = vi.fn(async () => {
      group.isExpanded = true;
    });

    await expect(refreshLoadedMongoIndexes({ treeNodes: [group], loadIndexes }, scope)).resolves.toBe(true);

    expect(loadIndexes).toHaveBeenCalledWith("conn-1", "app", "users", undefined, group.id, undefined);
    expect(group.isExpanded).toBe(false);
  });

  it("restores expansion state and preserves a refresh failure", async () => {
    const group = indexesGroup(false);
    const failure = new Error("metadata unavailable");
    const loadIndexes = vi.fn(async () => {
      group.isExpanded = true;
      throw failure;
    });

    await expect(refreshLoadedMongoIndexes({ treeNodes: [group], loadIndexes }, scope)).rejects.toBe(failure);
    expect(group.isExpanded).toBe(false);
  });
});
