import { describe, expect, it, vi } from "vitest";
import { copySelectedConnectionsToClipboards, selectedConnectionDeleteTargets, selectedConnectionDuplicateTargets } from "@/lib/sidebar/sidebarConnectionSelection";
import type { TreeNode } from "@/types/database";

function node(id: string, type: TreeNode["type"] = "connection"): TreeNode {
  return {
    id,
    label: id,
    type,
    connectionId: type === "connection" ? id : undefined,
  };
}

describe("sidebar connection selection", () => {
  it("uses all selected connections when the current connection is selected", () => {
    const current = node("conn-2");
    const selected = [node("conn-1"), current, node("conn-3")];

    expect(selectedConnectionDuplicateTargets(current, selected).map((item) => item.connectionId)).toEqual(["conn-1", "conn-2", "conn-3"]);
  });

  it("falls back to the current connection when the selection is mixed", () => {
    const current = node("conn-1");
    const selected = [current, node("group-1", "connection-group")];

    expect(selectedConnectionDuplicateTargets(current, selected).map((item) => item.connectionId)).toEqual(["conn-1"]);
  });

  it("keeps delete and duplicate target selection aligned", () => {
    const current = node("conn-1");
    const selected = [current, node("conn-2")];

    expect(selectedConnectionDuplicateTargets(current, selected)).toEqual(selectedConnectionDeleteTargets(current, selected));
  });

  it("copies selected connection names to the system clipboard for the sidebar copy shortcut", () => {
    const copyConnectionsToTreeClipboard = vi.fn(() => 2);
    const copyToSystemClipboard = vi.fn(() => Promise.resolve());

    expect(copySelectedConnectionsToClipboards([node("conn-1"), node("conn-2")], copyConnectionsToTreeClipboard, copyToSystemClipboard)).toBe(2);
    expect(copyConnectionsToTreeClipboard).toHaveBeenCalledWith(["conn-1", "conn-2"]);
    expect(copyToSystemClipboard).toHaveBeenCalledWith("conn-1\nconn-2");
  });

  it("keeps the tree clipboard copy when system clipboard access is denied", async () => {
    const copyConnectionsToTreeClipboard = vi.fn(() => 1);
    const copyToSystemClipboard = vi.fn(() => Promise.reject(new Error("denied")));

    expect(copySelectedConnectionsToClipboards([node("conn-1")], copyConnectionsToTreeClipboard, copyToSystemClipboard)).toBe(1);
    await Promise.resolve();
    expect(copyConnectionsToTreeClipboard).toHaveBeenCalledWith(["conn-1"]);
  });
});
