import { describe, expect, it, vi } from "vitest";
import { acceptWorkspaceTransfer, isWorkspaceTabWindowLabel, waitForWorkspaceTransfer, type WorkspaceTabHandoff } from "../workspaceTabTransfer";

describe("workspace tab transfer", () => {
  it("excludes previews, plugins and upstream single-tab windows", () => {
    expect(isWorkspaceTabWindowLabel("main")).toBe(true);
    expect(isWorkspaceTabWindowLabel("dbx-tab-a")).toBe(true);
    for (const label of ["dbx-tab-drag-preview", "plugin-floating-a", "detached-tab-a"]) expect(isWorkspaceTabWindowLabel(label)).toBe(false);
  });

  it("waits for target persistence before the source may remove its tab", async () => {
    const status = vi.fn().mockResolvedValueOnce("pending").mockResolvedValue("committed");
    const cancel = vi.fn();
    expect(await waitForWorkspaceTransfer({ status, cancel, delay: async () => {} })).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("honors a commit racing the source timeout", async () => {
    expect(await waitForWorkspaceTransfer({ status: async () => "pending", cancel: async () => "committed", delay: async () => {} }, 1)).toBe(true);
    expect(await waitForWorkspaceTransfer({ status: async () => "pending", cancel: async () => "cancelled", delay: async () => {} }, 1)).toBe(false);
  });

  const handoff = { tabId: "tab-a" } as WorkspaceTabHandoff;
  function receiver() {
    const tabs = new Set<string>();
    return {
      tabs,
      handoff,
      hasTab: (id: string) => tabs.has(id),
      adopt: vi.fn(async () => {
        tabs.add(handoff.tabId);
      }),
      persist: vi.fn(async () => {}),
      commit: vi.fn(async () => "committed" as const),
      abort: vi.fn(async () => "cancelled" as const),
      remove: vi.fn((id: string) => {
        tabs.delete(id);
      }),
    };
  }

  it("persists before committing", async () => {
    const target = receiver();
    expect(await acceptWorkspaceTransfer(target)).toBe(true);
    expect(target.tabs.has(handoff.tabId)).toBe(true);
    expect(target.persist.mock.invocationCallOrder[0]).toBeLessThan(target.commit.mock.invocationCallOrder[0]!);
  });

  it("rolls back a late receiver after cancellation", async () => {
    const target = receiver();
    expect(await acceptWorkspaceTransfer({ ...target, commit: async () => "cancelled" })).toBe(false);
    expect(target.tabs.size).toBe(0);
    expect(target.persist).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge a failed disk write", async () => {
    const target = receiver();
    target.persist.mockRejectedValueOnce(new Error("disk full"));
    await expect(acceptWorkspaceTransfer(target)).rejects.toThrow("disk full");
    expect(target.tabs.size).toBe(0);
    expect(target.commit).not.toHaveBeenCalled();
  });

  it("never replaces an existing target tab", async () => {
    const target = receiver();
    target.tabs.add(handoff.tabId);
    await expect(acceptWorkspaceTransfer(target)).rejects.toThrow("already contains");
    expect(target.adopt).not.toHaveBeenCalled();
    expect(target.remove).not.toHaveBeenCalled();
  });

  it("keeps the target when a commit succeeded but its response was lost", async () => {
    const target = receiver();
    target.commit.mockRejectedValueOnce(new Error("IPC interrupted"));
    expect(await acceptWorkspaceTransfer({ ...target, abort: async () => "committed" })).toBe(true);
    expect(target.tabs.has(handoff.tabId)).toBe(true);
    expect(target.remove).not.toHaveBeenCalled();
  });
});
