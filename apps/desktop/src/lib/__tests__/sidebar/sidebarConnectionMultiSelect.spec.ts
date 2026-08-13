import { describe, expect, it } from "vitest";
import { applyConnectionMultiSelection, applyTreeNodeSelection, connectionMultiSelectionAfterToggle, emptyConnectionMultiSelection, isExitConnectionMultiSelectionShortcut, releaseConnectionFromMultiSelection } from "@/lib/sidebar/sidebarConnectionMultiSelect";
import type { ConnectionMultiSelection, ConnectionMultiSelectionTarget } from "@/lib/sidebar/sidebarConnectionMultiSelect";

function tick(selection: ConnectionMultiSelection, ...connectionIds: string[]): ConnectionMultiSelection {
  return connectionIds.reduce(connectionMultiSelectionAfterToggle, selection);
}

function target(): ConnectionMultiSelectionTarget {
  return { selectedTreeNodeIds: [], selectedTreeNodeId: null, treeSelectionAnchorId: null, connectionMultiSelectActive: false };
}

describe("connection multi-selection", () => {
  it("uses plain Escape to exit connection multi-select", () => {
    const event = (key: string, modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}) => ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...modifiers,
    });

    expect(isExitConnectionMultiSelectionShortcut(event("Escape"))).toBe(true);
    expect(isExitConnectionMultiSelectionShortcut(event("Escape", { metaKey: true }))).toBe(false);
    expect(isExitConnectionMultiSelectionShortcut(event("Enter"))).toBe(false);
  });

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

  it("enables checkbox mode for a modifier-key selection containing only connections", () => {
    const store = target();

    applyTreeNodeSelection(store, { nodeIds: ["conn-1", "conn-2"], activeNodeId: "conn-2", anchorNodeId: "conn-2" }, new Set(["conn-1", "conn-2"]));

    expect(store.selectedTreeNodeIds).toEqual(["conn-1", "conn-2"]);
    expect(store.connectionMultiSelectActive).toBe(true);
  });

  it("keeps mixed modifier-key selections out of connection checkbox mode", () => {
    const store = target();

    applyTreeNodeSelection(store, { nodeIds: ["conn-1", "database-1"], activeNodeId: "database-1", anchorNodeId: "conn-1" }, new Set(["conn-1", "conn-2"]));

    expect(store.selectedTreeNodeIds).toEqual(["conn-1", "database-1"]);
    expect(store.connectionMultiSelectActive).toBe(false);
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

  it("releases only the connection that was moved from a multi-selection", () => {
    const store = target();
    applyConnectionMultiSelection(store, tick(emptyConnectionMultiSelection(), "conn-1", "conn-2", "conn-3"));

    releaseConnectionFromMultiSelection(store, "conn-3");

    expect(store).toEqual({
      selectedTreeNodeIds: ["conn-1", "conn-2"],
      selectedTreeNodeId: "conn-1",
      treeSelectionAnchorId: "conn-1",
      connectionMultiSelectActive: true,
    });
  });

  it("leaves an unrelated multi-selection unchanged", () => {
    const store = target();
    applyConnectionMultiSelection(store, tick(emptyConnectionMultiSelection(), "conn-1", "conn-2"));

    releaseConnectionFromMultiSelection(store, "conn-3");

    expect(store.selectedTreeNodeIds).toEqual(["conn-1", "conn-2"]);
    expect(store.connectionMultiSelectActive).toBe(true);
  });
});
