import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

function connection(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    connect_timeout_secs: 10,
    query_timeout_secs: 30,
    connect_timeout_inherit: false,
    query_timeout_inherit: false,
  };
}

function ungrouped(): SidebarLayout {
  return { groups: [], order: [{ type: "connection", id: "a" }] };
}

function grouped(): SidebarLayout {
  return {
    groups: [{ id: "g", name: "G", collapsed: false }],
    order: [{ type: "group", id: "g", children: [{ type: "connection", id: "a" }] }],
  };
}

let loadSidebarLayout: Mock;
let saveSidebarLayout: Mock;

describe("connectionStore adopting a sidebar layout written elsewhere", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    loadSidebarLayout = vi.fn().mockResolvedValue(null);
    saveSidebarLayout = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      loadEditorSettings: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveEditorSettings: vi.fn().mockResolvedValue(undefined),
      loadSidebarLayout,
      saveSidebarLayout,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
    }));
    setActivePinia(createPinia());
  });

  async function storeWithFlatLayout() {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [connection("a")];
    store.sidebarLayout = ungrouped();
    return store;
  }

  it("adopts a layout another process wrote while the app was idle", async () => {
    const store = await storeWithFlatLayout();
    loadSidebarLayout.mockResolvedValue(grouped());

    await store.syncSidebarLayoutOnce();

    expect(store.groupIdForConnection("a")).toBe("g");
  });

  it("does not revert a local edit that is still inside its debounce window", async () => {
    vi.useFakeTimers();
    const store = await storeWithFlatLayout();
    loadSidebarLayout.mockResolvedValue(ungrouped());
    await store.syncSidebarLayoutOnce();

    store.moveConnectionToGroup("a", store.createConnectionGroup("G"));
    loadSidebarLayout.mockResolvedValue(ungrouped());

    await store.syncSidebarLayoutOnce();

    expect(store.groupIdForConnection("a")).not.toBeNull();
    vi.useRealTimers();
  });

  it("discards a read that overlapped a local edit", async () => {
    const store = await storeWithFlatLayout();
    let resolveRead: (layout: SidebarLayout | null) => void = () => {};
    loadSidebarLayout.mockReturnValue(
      new Promise<SidebarLayout | null>((resolve) => {
        resolveRead = resolve;
      }),
    );

    const pending = store.syncSidebarLayoutOnce();
    store.moveConnectionToGroup("a", store.createConnectionGroup("G"));
    resolveRead(ungrouped());
    await pending;

    expect(store.groupIdForConnection("a")).not.toBeNull();
  });

  it("does not fight the save it dispatched", async () => {
    vi.useFakeTimers();
    const store = await storeWithFlatLayout();
    loadSidebarLayout.mockResolvedValue(ungrouped());
    await store.syncSidebarLayoutOnce();

    let resolveSave: () => void = () => {};
    saveSidebarLayout.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const groupId = store.createConnectionGroup("G");
    store.moveConnectionToGroup("a", groupId);
    await vi.advanceTimersByTimeAsync(300);
    expect(saveSidebarLayout).toHaveBeenCalled();

    // The row is not committed yet, so a read here still returns the old layout.
    loadSidebarLayout.mockResolvedValue(ungrouped());
    await store.syncSidebarLayoutOnce();
    expect(store.groupIdForConnection("a")).toBe(groupId);

    resolveSave();
    await Promise.resolve();
    expect(store.groupIdForConnection("a")).toBe(groupId);
    vi.useRealTimers();
  });

  it("serializes overlapping saves so an older snapshot cannot land last", async () => {
    vi.useFakeTimers();
    const store = await storeWithFlatLayout();
    loadSidebarLayout.mockResolvedValue(ungrouped());
    await store.syncSidebarLayoutOnce();

    const deferred: Array<{ layout: SidebarLayout; resolve: () => void }> = [];
    saveSidebarLayout.mockImplementation(
      (layout: SidebarLayout) =>
        new Promise<void>((resolve) => {
          deferred.push({ layout, resolve });
        }),
    );

    const first = store.createConnectionGroup("G1");
    store.moveConnectionToGroup("a", first);
    await vi.advanceTimersByTimeAsync(300);
    expect(deferred).toHaveLength(1);

    const second = store.createConnectionGroup("G2");
    store.moveConnectionToGroup("a", second);
    await vi.advanceTimersByTimeAsync(300);
    // A newer snapshot waits for the older write, so the row cannot be committed
    // out of order and the poll cannot adopt the older layout afterwards.
    expect(deferred).toHaveLength(1);

    deferred[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(deferred).toHaveLength(2);
    expect(store.groupIdForConnection("a")).toBe(second);

    deferred[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.groupIdForConnection("a")).toBe(second);

    // The watermark must describe the settled layout, otherwise a genuinely new
    // external write would never be adopted again.
    const external: SidebarLayout = {
      groups: [{ id: "ext", name: "Ext", collapsed: false }],
      order: [{ type: "group", id: "ext", children: [{ type: "connection", id: "a" }] }],
    };
    loadSidebarLayout.mockResolvedValue(external);
    await store.syncSidebarLayoutOnce();
    expect(store.groupIdForConnection("a")).toBe("ext");
    vi.useRealTimers();
  });

  it("keeps a sidebar edit that lands while a deletion is persisting", async () => {
    vi.useFakeTimers();
    const store = await storeWithFlatLayout();
    store.connections = [connection("a"), connection("b")];
    store.sidebarLayout = {
      groups: [],
      order: [
        { type: "connection", id: "a" },
        { type: "connection", id: "b" },
      ],
    };
    loadSidebarLayout.mockResolvedValue(null);
    await store.syncSidebarLayoutOnce();

    const api = await import("@/lib/backend/api");
    let resolveConnections: () => void = () => {};
    (api.saveConnections as Mock).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveConnections = resolve;
      }),
    );

    const deletion = store.removeConnections(["a"]);
    // The user groups "b" while the connection rows are still being written. The
    // deletion must apply to the layout as it stands now, not to the snapshot it
    // captured before that edit.
    const groupId = store.createConnectionGroup("G");
    store.moveConnectionToGroup("b", groupId);
    resolveConnections();
    await deletion;
    await vi.advanceTimersByTimeAsync(300);

    const saved = saveSidebarLayout.mock.calls.at(-1)?.[0] as SidebarLayout;
    expect(saved.groups.map((group) => group.name)).toEqual(["G"]);
    expect(store.groupIdForConnection("b")).toBe(groupId);
    vi.useRealTimers();
  });

  it("retries a failed save so external changes can still be adopted", async () => {
    vi.useFakeTimers();
    const store = await storeWithFlatLayout();
    loadSidebarLayout.mockResolvedValue(ungrouped());
    await store.syncSidebarLayoutOnce();

    saveSidebarLayout.mockRejectedValueOnce(new Error("disk unavailable"));
    store.moveConnectionToGroup("a", store.createConnectionGroup("G"));
    await vi.advanceTimersByTimeAsync(300);
    expect(saveSidebarLayout).toHaveBeenCalledTimes(1);

    // The retry keeps the watermark honest, so the poll is not blocked by the
    // failed write forever.
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveSidebarLayout).toHaveBeenCalledTimes(2);

    const remote: SidebarLayout = {
      groups: [{ id: "other", name: "Other", collapsed: false }],
      order: [{ type: "group", id: "other", children: [{ type: "connection", id: "a" }] }],
    };
    loadSidebarLayout.mockResolvedValue(remote);
    await store.syncSidebarLayoutOnce();
    expect(store.groupIdForConnection("a")).toBe("other");
    vi.useRealTimers();
  });

  it("adopts an external change once the local save has landed", async () => {
    vi.useFakeTimers();
    const store = await storeWithFlatLayout();
    loadSidebarLayout.mockResolvedValue(ungrouped());
    await store.syncSidebarLayoutOnce();

    const groupId = store.createConnectionGroup("G");
    store.moveConnectionToGroup("a", groupId);
    await vi.advanceTimersByTimeAsync(300);
    expect(saveSidebarLayout).toHaveBeenCalled();

    const remote: SidebarLayout = {
      groups: [{ id: "other", name: "Other", collapsed: false }],
      order: [{ type: "group", id: "other", children: [{ type: "connection", id: "a" }] }],
    };
    loadSidebarLayout.mockResolvedValue(remote);
    await store.syncSidebarLayoutOnce();

    expect(store.groupIdForConnection("a")).toBe("other");
    vi.useRealTimers();
  });
});

describe("connectionStore deleting a connection while the layout changes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    loadSidebarLayout = vi.fn().mockResolvedValue(null);
    saveSidebarLayout = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      loadEditorSettings: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveEditorSettings: vi.fn().mockResolvedValue(undefined),
      loadSidebarLayout,
      saveSidebarLayout,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
    }));
    setActivePinia(createPinia());
  });

  it("keeps a grouping edit made while the delete write was in flight", async () => {
    vi.resetModules();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [connection("a"), connection("b")];
    store.sidebarLayout = {
      groups: [],
      order: [
        { type: "connection", id: "a" },
        { type: "connection", id: "b" },
      ],
    } as SidebarLayout;

    const saving: Array<() => void> = [];
    saveSidebarLayout.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          saving.push(resolve);
        }),
    );
    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
      for (const resolve of saving.splice(0)) resolve();
    };

    const deleting = store.removeConnections(["b"]);
    // The user creates a group while the delete is still being written.
    const groupId = store.createConnectionGroup("G");
    await settle();
    await settle();
    await deleting;

    // The deletion is applied on top of the edit, not over it.
    expect(store.sidebarLayout.groups.some((group) => group.id === groupId)).toBe(true);
    expect(store.connections.some((c) => c.id === "b")).toBe(false);
  });
});
