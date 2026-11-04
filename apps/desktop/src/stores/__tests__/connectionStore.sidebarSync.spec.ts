import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

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

  async function deletionFixture() {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const api = await import("@/lib/backend/api");
    const settings = useSettingsStore();
    await settings.initEditorSettings();
    settings.editorSettings.connectTimeoutInheritConnectionIds = ["a", "b"];
    settings.editorSettings.queryTimeoutInheritConnectionIds = ["a"];
    const store = useConnectionStore();
    store.connections = [connection("a"), connection("b")];
    store.sidebarLayout = {
      groups: [{ id: "original", name: "Original", collapsed: false }],
      order: [
        { type: "group", id: "original", children: [{ type: "connection", id: "a" }] },
        { type: "connection", id: "b" },
      ],
    };
    vi.useFakeTimers();
    return { store, settings, api };
  }

  it("waits for the deletion's retry to succeed before removing the connection", async () => {
    const { store } = await deletionFixture();
    saveSidebarLayout.mockRejectedValueOnce(new Error("disk unavailable"));
    let settled = false;
    const deleting = store.removeConnections(["a"]).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(store.connections.map((c) => c.id)).toContain("a");
    await vi.advanceTimersByTimeAsync(1000);
    await deleting;
    expect(saveSidebarLayout).toHaveBeenCalledTimes(2);
    expect(store.connections.map((c) => c.id)).toEqual(["b"]);
  });

  it.each(["layout", "connections", "timeout"] as const)("restores memory and storage after %s failure, preserving concurrent group edits", async (failure) => {
    const { store, settings, api } = await deletionFixture();
    const original = JSON.parse(JSON.stringify(store.sidebarLayout));
    const disk = { layout: original, ids: ["a", "b"] };
    const error = new Error(`${failure} failed`);
    let rejectWrite: (error: Error) => void = () => {};
    const blocked = new Promise<void>((_, reject) => {
      rejectWrite = reject;
    });
    (api.saveConnections as Mock).mockImplementation(async (configs) => {
      disk.ids = configs.map((c: ConnectionConfig) => c.id);
    });
    saveSidebarLayout.mockImplementation(async (layout) => {
      disk.layout = JSON.parse(JSON.stringify(layout));
    });
    if (failure === "layout") saveSidebarLayout.mockImplementationOnce(() => blocked);
    if (failure === "connections") (api.saveConnections as Mock).mockImplementationOnce(() => blocked);
    if (failure === "timeout") (api.saveEditorSettings as Mock).mockImplementationOnce(() => blocked);
    const outcome = store.removeConnections(["a"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(0);
    const groupId = store.createConnectionGroup("Concurrent");
    store.moveConnectionToGroup("b", groupId);
    // Commit a newer snapshot before the failed operation resumes.
    await vi.advanceTimersByTimeAsync(300);
    rejectWrite(error);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await outcome).toBe(error);
    expect(store.connections.map((c) => c.id)).toEqual(["a", "b"]);
    expect(disk.ids).toEqual(["a", "b"]);
    expect(store.groupIdForConnection("a")).toBe("original");
    expect(store.groupIdForConnection("b")).toBe(groupId);
    expect(disk.layout).toEqual(JSON.parse(JSON.stringify(store.sidebarLayout)));
    expect(settings.editorSettings.connectTimeoutInheritConnectionIds).toEqual(["a", "b"]);
    expect(settings.editorSettings.queryTimeoutInheritConnectionIds).toEqual(["a"]);
    // Successful recovery must release polling again.
    loadSidebarLayout.mockResolvedValue(disk.layout);
    await store.syncSidebarLayoutOnce();
    expect(loadSidebarLayout).toHaveBeenCalled();
  });

  it("rejects exhausted retries and restores the original layout and connection settings", async () => {
    const { store, settings, api } = await deletionFixture();
    const original = JSON.parse(JSON.stringify(store.sidebarLayout));
    const error = new Error("disk unavailable");
    for (let i = 0; i < 4; i++) saveSidebarLayout.mockRejectedValueOnce(error);
    const outcome = store.removeConnections(["a"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(await outcome).toBe(error);
    expect(saveSidebarLayout).toHaveBeenCalledTimes(5);
    expect(saveSidebarLayout.mock.calls.at(-1)?.[0]).toEqual(original);
    expect(store.sidebarLayout).toEqual(original);
    expect(store.connections.map((c) => c.id)).toEqual(["a", "b"]);
    expect((api.saveConnections as Mock).mock.calls.at(-1)?.[0].map((c: ConnectionConfig) => c.id)).toEqual(["a", "b"]);
    expect(settings.editorSettings.queryTimeoutInheritConnectionIds).toEqual(["a"]);
  });

  it("restores deleted nested groups without reverting a concurrent move", async () => {
    const { store, api } = await deletionFixture();
    store.sidebarLayout.groups.push({ id: "nested", name: "Nested", collapsed: false });
    store.sidebarLayout.order = [
      { type: "group", id: "original", children: [{ type: "group", id: "nested", children: [{ type: "connection", id: "a" }] }] },
      { type: "connection", id: "b" },
    ];
    let rejectSettings: (error: Error) => void = () => {};
    (api.saveEditorSettings as Mock).mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectSettings = reject;
        }),
    );
    const outcome = store.deleteConnectionGroups(["original"], true).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(0);
    const groupId = store.createConnectionGroup("Concurrent");
    store.moveConnectionToGroup("b", groupId);
    await vi.advanceTimersByTimeAsync(300);
    rejectSettings(new Error("settings failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBeInstanceOf(Error);
    expect(store.groupIdForConnection("a")).toBe("nested");
    expect(store.groupIdForConnection("b")).toBe(groupId);
    expect(store.sidebarLayout.groups.map((g) => g.id)).toEqual(expect.arrayContaining(["original", "nested", groupId]));
  });

  it.each(["connections", "timeout"] as const)("restores the original layout after %s failure without another edit", async (failure) => {
    const { store, settings, api } = await deletionFixture();
    const original = JSON.parse(JSON.stringify(store.sidebarLayout));
    const error = new Error(`${failure} failed`);
    const failing = failure === "connections" ? api.saveConnections : api.saveEditorSettings;
    (failing as Mock).mockRejectedValueOnce(error);
    const outcome = store.removeConnections(["a"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe(error);
    expect(store.sidebarLayout).toEqual(original);
    expect(saveSidebarLayout.mock.calls.at(-1)?.[0]).toEqual(original);
    expect(store.connections.map((c) => c.id)).toEqual(["a", "b"]);
    expect(settings.editorSettings.queryTimeoutInheritConnectionIds).toEqual(["a"]);
  });

  it("consumes an exhausted layout save while connection persistence is still pending", async () => {
    const { store, api } = await deletionFixture();
    const error = new Error("layout failed");
    for (let i = 0; i < 4; i++) saveSidebarLayout.mockRejectedValueOnce(error);
    let resolveConnections: () => void = () => {};
    (api.saveConnections as Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveConnections = resolve;
        }),
    );
    const outcome = store.removeConnections(["a"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.connections.map((c) => c.id)).toContain("a");
    resolveConnections();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe(error);
    expect(store.groupIdForConnection("a")).toBe("original");
  });

  it("reports incomplete recovery while restoring the live tree even when storage stays unavailable", async () => {
    const { store } = await deletionFixture();
    const original = JSON.parse(JSON.stringify(store.sidebarLayout));
    const error = new Error("storage unavailable");
    saveSidebarLayout.mockRejectedValue(error);
    const outcome = store.removeConnections(["a"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(await outcome).toMatchObject({ message: expect.stringContaining("recovery was incomplete"), cause: error });
    expect(store.sidebarLayout).toEqual(original);
    expect(store.connections.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("blocks polling until the deletion's configuration writes finish", async () => {
    const { store, api } = await deletionFixture();
    let resolveConnections: () => void = () => {};
    (api.saveConnections as Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveConnections = resolve;
        }),
    );
    const deleting = store.removeConnections(["a"]);
    await vi.advanceTimersByTimeAsync(0);
    loadSidebarLayout.mockResolvedValue(ungrouped());
    await store.syncSidebarLayoutOnce();
    expect(loadSidebarLayout).not.toHaveBeenCalled();
    resolveConnections();
    await deleting;
  });

  it("undoes group flattening without moving a connection that the user moved elsewhere", async () => {
    const { store } = await deletionFixture();
    const error = new Error("layout failed");
    let rejectSave: (error: Error) => void = () => {};
    saveSidebarLayout.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectSave = reject;
        }),
    );
    const outcome = store.deleteConnectionGroups(["original"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(0);
    const groupId = store.createConnectionGroup("New home");
    store.moveConnectionToGroup("a", groupId);
    await vi.advanceTimersByTimeAsync(300);
    rejectSave(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe(error);
    expect(store.sidebarLayout.groups.map((g) => g.id)).toContain("original");
    expect(store.groupIdForConnection("a")).toBe(groupId);
    expect(saveSidebarLayout.mock.calls.at(-1)?.[0]).toEqual(store.sidebarLayout);
  });

  it("preserves a reorder at the same level after a failed group deletion", async () => {
    const { store } = await deletionFixture();
    const error = new Error("layout failed");
    let rejectSave: (error: Error) => void = () => {};
    saveSidebarLayout.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectSave = reject;
        }),
    );
    const outcome = store.deleteConnectionGroups(["original"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(0);
    store.reorderSidebarEntry("a", "b", "after");
    await vi.advanceTimersByTimeAsync(300);
    rejectSave(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe(error);
    expect(store.sidebarLayout.groups.map((group) => group.id)).toContain("original");
    expect(store.groupIdForConnection("a")).toBeNull();
    expect(store.sidebarLayout.order.filter((entry) => entry.type === "connection").map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(saveSidebarLayout.mock.calls.at(-1)?.[0]).toEqual(store.sidebarLayout);
  });

  it("preserves a move after a new sibling while group deletion is failing", async () => {
    const { store, settings } = await deletionFixture();
    store.connections = store.connections.filter((connection) => connection.id === "a");
    store.sidebarLayout.order = store.sidebarLayout.order.filter((entry) => entry.type === "group");
    settings.editorSettings.connectTimeoutInheritConnectionIds = ["a"];
    const error = new Error("layout failed");
    let rejectSave: (error: Error) => void = () => {};
    saveSidebarLayout.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectSave = reject;
        }),
    );
    const outcome = store.deleteConnectionGroups(["original"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(0);
    const newGroupId = store.createConnectionGroup("New sibling");
    store.reorderSidebarEntries(["a"], newGroupId, "after");
    await vi.advanceTimersByTimeAsync(300);
    rejectSave(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe(error);
    expect(store.groupIdForConnection("a")).toBeNull();
    expect(store.sidebarLayout.order.findIndex((entry) => entry.id === newGroupId)).toBeLessThan(store.sidebarLayout.order.findIndex((entry) => entry.id === "a"));
    expect(store.sidebarLayout.groups.map((group) => group.id)).toContain("original");
    expect(saveSidebarLayout.mock.calls.at(-1)?.[0]).toEqual(store.sidebarLayout);
  });

  it("keeps a newly appended group after the recovered group", async () => {
    const { store, settings } = await deletionFixture();
    store.connections = store.connections.filter((connection) => connection.id === "a");
    store.sidebarLayout.order = store.sidebarLayout.order.filter((entry) => entry.type === "group");
    settings.editorSettings.connectTimeoutInheritConnectionIds = ["a"];
    const error = new Error("layout failed");
    let rejectSave: (error: Error) => void = () => {};
    saveSidebarLayout.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectSave = reject;
        }),
    );
    const outcome = store.deleteConnectionGroups(["original"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(0);
    const newGroupId = store.createConnectionGroup("New sibling");
    await vi.advanceTimersByTimeAsync(300);
    rejectSave(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe(error);
    expect(store.groupIdForConnection("a")).toBe("original");
    expect(store.sidebarLayout.order.map((entry) => entry.id)).toEqual(["original", newGroupId]);
    expect(saveSidebarLayout.mock.calls.at(-1)?.[0]).toEqual(store.sidebarLayout);
  });

  it("restores an empty group before the flattened contents of its next sibling", async () => {
    const { store } = await deletionFixture();
    store.sidebarLayout.groups.unshift({ id: "empty", name: "Empty", collapsed: false });
    store.sidebarLayout.order.unshift({ type: "group", id: "empty", children: [] });
    const original = JSON.parse(JSON.stringify(store.sidebarLayout));
    const error = new Error("layout failed");
    for (let i = 0; i < 4; i++) saveSidebarLayout.mockRejectedValueOnce(error);
    const outcome = store.deleteConnectionGroups(["empty", "original"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(await outcome).toBe(error);
    expect(store.sidebarLayout.order).toEqual(original.order);
  });
});
