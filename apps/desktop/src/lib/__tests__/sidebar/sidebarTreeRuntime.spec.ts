import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/types/database";
import { createSidebarSelectionSnapshot, createSidebarTreeRuntime, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";

function node(id: string, label = id): TreeNode {
  return { id, label, type: "table", connectionId: "connection-1", database: "database-1" };
}

function host(): SidebarTreeRuntimeHost {
  return {
    buildContextMenu: vi.fn(() => []),
    handleRowClick: vi.fn(),
    handleRowDoubleClick: vi.fn(),
    handleRowKeydown: vi.fn(),
    openDataInNewTab: vi.fn(),
    requestPaste: vi.fn(() => false),
    toggleNode: vi.fn(),
  };
}

describe("sidebar tree runtime", () => {
  it("keeps target and selection snapshots immutable", () => {
    const first = node("table-1", "before");
    const second = node("table-2");
    const selectedIds = [first.id];
    const snapshot = createSidebarSelectionSnapshot([first, second], selectedIds);

    first.label = "after";
    selectedIds.push(second.id);

    expect(snapshot.ids).toEqual(["table-1"]);
    expect(snapshot.targets).toEqual([expect.objectContaining({ id: "table-1", label: "before" })]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.ids)).toBe(true);
    expect(Object.isFrozen(snapshot.targets)).toBe(true);
  });

  it("shares one host across many row consumers", () => {
    const runtime = createSidebarTreeRuntime();
    const runtimeHost = host();
    runtime.bindHost(runtimeHost);

    for (let index = 0; index < 100; index += 1) runtime.handleRowClick(node(`table-${index}`), 1);

    expect(runtime.diagnostics.hostBindings).toBe(1);
    expect(runtimeHost.handleRowClick).toHaveBeenCalledTimes(100);
  });

  it("rejects superseded and disposed generations without affecting another runtime", () => {
    const runtime = createSidebarTreeRuntime();
    const otherRuntime = createSidebarTreeRuntime();
    const first = runtime.beginAction();
    const unrelated = otherRuntime.beginAction();
    const second = runtime.beginAction();

    expect(runtime.isCurrent(first)).toBe(false);
    expect(runtime.isCurrent(second)).toBe(true);
    expect(otherRuntime.isCurrent(unrelated)).toBe(true);

    runtime.dispose();

    expect(runtime.isCurrent(second)).toBe(false);
    expect(otherRuntime.isCurrent(unrelated)).toBe(true);
  });
});
