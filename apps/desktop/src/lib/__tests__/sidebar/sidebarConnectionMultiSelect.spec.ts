import { describe, expect, it } from "vitest";
import { applyConnectionMultiSelection, connectionMultiSelectionAfterToggle, emptyConnectionMultiSelection } from "@/lib/sidebar/sidebarConnectionMultiSelect";
import type { ConnectionMultiSelection, ConnectionMultiSelectionTarget } from "@/lib/sidebar/sidebarConnectionMultiSelect";

function tick(selection: ConnectionMultiSelection, ...connectionIds: string[]): ConnectionMultiSelection {
  return connectionIds.reduce(connectionMultiSelectionAfterToggle, selection);
}

function target(): ConnectionMultiSelectionTarget {
  return { selectedTreeNodeIds: [], selectedTreeNodeId: null, treeSelectionAnchorId: null, connectionMultiSelectActive: false };
}

describe("connection multi-selection", () => {
  it("adds each ticked connection to the running selection", () => {
    const selection = tick(emptyConnectionMultiSelection(), "conn-1", "conn-2", "conn-3");

    expect(selection.connectionIds).toEqual(["conn-1", "conn-2", "conn-3"]);
    expect(selection.activeConnectionId).toBe("conn-3");
    expect(selection.anchorConnectionId).toBe("conn-3");
    expect(selection.active).toBe(true);
  });

  it("drops a connection that is ticked twice", () => {
    const selection = tick(emptyConnectionMultiSelection(), "conn-1", "conn-2", "conn-2");

    expect(selection.connectionIds).toEqual(["conn-1"]);
    expect(selection.activeConnectionId).toBe("conn-1");
    expect(selection.active).toBe(true);
  });

  it("leaves multi-select off once the last connection is unticked", () => {
    const selection = tick(emptyConnectionMultiSelection(), "conn-1", "conn-1");

    expect(selection.connectionIds).toEqual([]);
    expect(selection.activeConnectionId).toBeNull();
    expect(selection.active).toBe(false);
  });

  it("does not carry a moved batch into the next group (issue #5758)", () => {
    const moved = tick(emptyConnectionMultiSelection(), "conn-1", "conn-2", "conn-3");
    expect(moved.connectionIds).toEqual(["conn-1", "conn-2", "conn-3"]);

    // Moving the batch into a group releases the selection, so the next batch
    // starts from nothing instead of dragging conn-1..3 along with it.
    const next = tick(emptyConnectionMultiSelection(), "conn-4", "conn-5", "conn-6");

    expect(next.connectionIds).toEqual(["conn-4", "conn-5", "conn-6"]);
  });

  it("writes the selection back to the tree selection fields", () => {
    const store = target();

    applyConnectionMultiSelection(store, tick(emptyConnectionMultiSelection(), "conn-1", "conn-2"));

    expect(store).toEqual({
      selectedTreeNodeIds: ["conn-1", "conn-2"],
      selectedTreeNodeId: "conn-2",
      treeSelectionAnchorId: "conn-2",
      connectionMultiSelectActive: true,
    });
  });

  it("clears every tree selection field when the selection is released", () => {
    const store = target();
    applyConnectionMultiSelection(store, tick(emptyConnectionMultiSelection(), "conn-1"));

    applyConnectionMultiSelection(store, emptyConnectionMultiSelection());

    expect(store).toEqual({
      selectedTreeNodeIds: [],
      selectedTreeNodeId: null,
      treeSelectionAnchorId: null,
      connectionMultiSelectActive: false,
    });
  });
});
