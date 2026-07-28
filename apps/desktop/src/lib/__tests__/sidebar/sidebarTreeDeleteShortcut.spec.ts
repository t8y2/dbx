// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import type { DatabaseType, TreeNode } from "@/types/database";
import { handleSidebarTreeDeleteShortcut } from "@/lib/sidebar/sidebarTreeDeleteShortcut";

function tableNode(id: string, connectionId: string): TreeNode {
  return {
    id,
    label: id,
    type: "table",
    connectionId,
    database: "default",
  };
}

function databaseTypeForNode(node: TreeNode): DatabaseType | undefined {
  return node.connectionId === "hbase-connection" ? "hbase" : "postgresql";
}

function deleteEvent(key: "Delete" | "Backspace", init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, cancelable: true, ...init });
}

describe("sidebar tree delete shortcut", () => {
  it.each(["Delete", "Backspace"] as const)("routes %s for a single HBase table through REST deletion", (key) => {
    const activeNode = tableNode("table-1", "hbase-connection");
    const event = deleteEvent(key);
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    const requestHBaseTableDelete = vi.fn(() => true);
    const requestDefaultDelete = vi.fn(() => true);

    expect(
      handleSidebarTreeDeleteShortcut(event, {
        activeNode,
        selectedNodes: [activeNode],
        databaseTypeForNode,
        requestHBaseTableDelete,
        requestDefaultDelete,
      }),
    ).toBe(true);
    expect(requestHBaseTableDelete).toHaveBeenCalledOnce();
    expect(requestDefaultDelete).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("blocks unsupported HBase multi-selection before generic SQL deletion", () => {
    const activeNode = tableNode("table-1", "hbase-connection");
    const selectedNodes = [activeNode, tableNode("table-2", "hbase-connection")];
    const event = deleteEvent("Delete");
    const requestHBaseTableDelete = vi.fn(() => true);
    const requestDefaultDelete = vi.fn(() => true);

    expect(
      handleSidebarTreeDeleteShortcut(event, {
        activeNode,
        selectedNodes,
        databaseTypeForNode,
        requestHBaseTableDelete,
        requestDefaultDelete,
      }),
    ).toBe(true);
    expect(requestHBaseTableDelete).not.toHaveBeenCalled();
    expect(requestDefaultDelete).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps the existing generic delete route for SQL tables", () => {
    const activeNode = tableNode("table-1", "postgres-connection");
    const event = deleteEvent("Delete");
    const requestHBaseTableDelete = vi.fn(() => true);
    const requestDefaultDelete = vi.fn(() => true);

    expect(
      handleSidebarTreeDeleteShortcut(event, {
        activeNode,
        selectedNodes: [activeNode],
        databaseTypeForNode,
        requestHBaseTableDelete,
        requestDefaultDelete,
      }),
    ).toBe(true);
    expect(requestHBaseTableDelete).not.toHaveBeenCalled();
    expect(requestDefaultDelete).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores modified delete shortcuts", () => {
    const activeNode = tableNode("table-1", "hbase-connection");
    const event = deleteEvent("Delete", { ctrlKey: true });
    const requestHBaseTableDelete = vi.fn(() => true);
    const requestDefaultDelete = vi.fn(() => true);

    expect(
      handleSidebarTreeDeleteShortcut(event, {
        activeNode,
        selectedNodes: [activeNode],
        databaseTypeForNode,
        requestHBaseTableDelete,
        requestDefaultDelete,
      }),
    ).toBe(false);
    expect(requestHBaseTableDelete).not.toHaveBeenCalled();
    expect(requestDefaultDelete).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
