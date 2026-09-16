import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryStore } from "@/stores/queryStore";

describe("queryStore openPluginWorkbench reuse", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    setActivePinia(createPinia());
  });

  it("reopening an open workbench surfaces the tab as-is without replacing its context", async () => {
    const queryStore = useQueryStore();

    const firstId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      title: "hktkosl1103",
      connectionId: "conn-1",
      context: { connectionId: "conn-1", workbenchId: "wb-original" },
    });

    // A later reopen (e.g. another sidebar click) carries a freshly minted
    // context; the tab must keep the original one — a replacement would
    // deep-reload the plugin webview (full flash) and orphan the sidecar
    // session bound to the original workbench id.
    const secondId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      title: "hktkosl1103",
      connectionId: "conn-1",
      context: { connectionId: "conn-1", workbenchId: "wb-fresh" },
    });

    expect(secondId).toBe(firstId);
    expect(queryStore.activeTabId).toBe(firstId);
    const tab = queryStore.tabs.find((t) => t.id === firstId);
    expect(tab?.pluginWorkbench?.context).toEqual({ connectionId: "conn-1", workbenchId: "wb-original" });
  });

  it("a different connection still opens its own workbench tab", () => {
    const queryStore = useQueryStore();

    const firstId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      connectionId: "conn-1",
      context: { connectionId: "conn-1", workbenchId: "wb-1" },
    });
    const secondId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      connectionId: "conn-2",
      context: { connectionId: "conn-2", workbenchId: "wb-2" },
    });

    expect(secondId).not.toBe(firstId);
    expect(queryStore.tabs).toHaveLength(2);
  });

  it("registers the workbench tab into the focused group so the group tab strip can render it", () => {
    const queryStore = useQueryStore();

    const id = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      connectionId: "conn-1",
      context: { connectionId: "conn-1" },
    });

    // The split workspace renders tab strips from group membership: a tab
    // pushed straight onto `tabs` stays ownerless and never shows up in any
    // strip (regression behind "click a sidebar connection, no tab appears").
    const group = queryStore.groups.find((candidate) => candidate.tabIds.includes(id));
    expect(group).toBeDefined();
    expect(group?.activeTabId).toBe(id);
    expect(queryStore.focusedGroupId).toBe(group?.id);
  });

  it("adopts a legacy ownerless workbench tab back into the workspace when reopened", () => {
    const queryStore = useQueryStore();

    const id = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      connectionId: "conn-1",
      context: { connectionId: "conn-1" },
    });
    // Simulate a tab created by a pre-registry build (ownerless) or a restore
    // edge: strip it from its group, then reopen from the sidebar.
    queryStore.groups = [{ id: "main", tabIds: [], activeTabId: null }];

    const reopenedId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      connectionId: "conn-1",
      context: { connectionId: "conn-1", workbenchId: "wb-fresh" },
    });

    expect(reopenedId).toBe(id);
    expect(queryStore.groups[0]?.tabIds).toContain(id);
    expect(queryStore.groups[0]?.activeTabId).toBe(id);
    // Adoption must not replace the live context (same no-deep-reload rule).
    expect(queryStore.tabs.find((t) => t.id === id)?.pluginWorkbench?.context).toEqual({ connectionId: "conn-1" });
  });
});
