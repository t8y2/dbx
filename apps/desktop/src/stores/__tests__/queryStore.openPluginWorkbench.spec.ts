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

  it("numbers same-connection session tabs Termius-style and never backfills", async () => {
    const queryStore = useQueryStore();

    // First tab keeps the bare connection name; numbering starts at (1) from
    // the second tab on.
    const firstId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      title: "SSH server222",
      connectionId: "conn-1",
      context: { connectionId: "conn-1" },
    });
    // forceNew is orthogonal to numbering: it skips dedup, the count still grows.
    const secondId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      title: "SSH server222",
      connectionId: "conn-1",
      context: { connectionId: "conn-1", workbenchId: "wb-2" },
      forceNew: true,
    });
    const thirdId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      title: "SSH server222",
      connectionId: "conn-1",
      context: { connectionId: "conn-1", workbenchId: "wb-3" },
      forceNew: true,
    });

    const titles = Object.fromEntries(queryStore.tabs.map((tab) => [tab.id, tab.title]));
    expect([titles[firstId], titles[secondId], titles[thirdId]]).toEqual(["SSH server222", "SSH server222 (1)", "SSH server222 (2)"]);

    // Closing tab (1) must not renumber (2): existing titles stay stable (no
    // backfill, no drift). The next tab advances beyond the highest live suffix
    // so two open sessions never share a title. (Removed directly: the stubbed
    // window in this harness lacks the timers closeTab's cleanup needs.)
    queryStore.tabs = queryStore.tabs.filter((tab) => tab.id !== secondId);
    const fourthId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      title: "SSH server222",
      connectionId: "conn-1",
      context: { connectionId: "conn-1", workbenchId: "wb-4" },
      forceNew: true,
    });
    expect(queryStore.tabs.find((tab) => tab.id === thirdId)?.title).toBe("SSH server222 (2)");
    expect(queryStore.tabs.find((tab) => tab.id === fourthId)?.title).toBe("SSH server222 (3)");

    // Closing the highest suffix may reuse that now-free number, but must not
    // collide with any session that remains open.
    queryStore.tabs = queryStore.tabs.filter((tab) => tab.id !== fourthId);
    const fifthId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      title: "SSH server222",
      connectionId: "conn-1",
      context: { connectionId: "conn-1", workbenchId: "wb-5" },
      forceNew: true,
    });
    expect(queryStore.tabs.find((tab) => tab.id === fifthId)?.title).toBe("SSH server222 (3)");
  });

  it("numbers sessions independently per connection and reads bridge-style context-only connection ids", async () => {
    const queryStore = useQueryStore();

    queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", { title: "A", connectionId: "conn-1", context: { connectionId: "conn-1" }, forceNew: true });
    const otherConnectionId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", { title: "B", connectionId: "conn-2", context: { connectionId: "conn-2" }, forceNew: true });
    // A different connection keeps its own bare title, unaffected by conn-1's count.
    expect(queryStore.tabs.find((tab) => tab.id === otherConnectionId)?.title).toBe("B");

    // Bridge-path legacy tab: connection only inside context (tab-level "").
    // It must join conn-1's numbering (second conn-1 tab → (1)) and its own
    // tab-level connectionId gets normalized for reconnect/restore logic.
    const bridgedId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", { title: "A", context: { connectionId: "conn-1" }, forceNew: true });
    const bridged = queryStore.tabs.find((tab) => tab.id === bridgedId);
    expect(bridged?.title).toBe("A (1)");
    expect(bridged?.connectionId).toBe("conn-1");
  });
});
