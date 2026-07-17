import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { createSidebarActionRequest, createSidebarActionTarget, findSidebarActionTarget, releaseRemovedSidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";

function tableNode(): TreeNode {
  return {
    id: "table-1",
    label: "users",
    type: "table",
    connectionId: "connection-1",
    database: "app",
    schema: "public",
    children: [{ id: "column-1", label: "id", type: "column" }],
  };
}

describe("sidebar action targets", () => {
  it("captures a frozen shallow snapshot without retaining children", () => {
    const node = tableNode();
    const target = createSidebarActionTarget(node);

    node.label = "recycled-row";
    node.connectionId = "connection-2";

    expect(target).toMatchObject({ label: "users", connectionId: "connection-1", children: undefined, hiddenChildren: undefined });
    expect(Object.isFrozen(target)).toBe(true);
  });

  it("captures selection independently from later selection changes", () => {
    const selectedNodeIds = ["table-1", "table-2"];
    const request = createSidebarActionRequest(tableNode(), selectedNodeIds, { initialEditing: true });

    selectedNodeIds.splice(0, selectedNodeIds.length, "table-3");

    expect(request.selectedNodeIds).toEqual(["table-1", "table-2"]);
    expect(request.payload).toEqual({ initialEditing: true });
    expect(Object.isFrozen(request.selectedNodeIds)).toBe(true);
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("does not resolve a recycled row with the same local id", () => {
    const target = createSidebarActionTarget(tableNode());
    const recycled = tableNode();
    recycled.connectionId = "connection-2";

    expect(findSidebarActionTarget([recycled], target)).toBeNull();
  });

  it("returns null when the action target was removed", () => {
    const target = createSidebarActionTarget(tableNode());

    expect(findSidebarActionTarget([], target)).toBeNull();
  });

  it("releases a removed active node's child tree", () => {
    const node = tableNode();
    const released = releaseRemovedSidebarActionTarget(node, [node.id]);

    expect(released).not.toBe(node);
    expect(released.children).toBeUndefined();
    expect(released.hiddenChildren).toBeUndefined();
  });

  it("keeps an active node that was not removed", () => {
    const node = tableNode();

    expect(releaseRemovedSidebarActionTarget(node, ["other-node"])).toBe(node);
  });

  it("resolves targets stored only in hidden children", () => {
    const node = tableNode();
    const target = createSidebarActionTarget(node);
    const root: TreeNode = { id: "root", label: "root", type: "database", hiddenChildren: [node] };

    expect(findSidebarActionTarget([root], target)).toBe(node);
  });
});
