import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function installApiMocks() {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    connectDb: vi.fn().mockResolvedValue("preview-1"),
    disconnectDb: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    loadConnections: vi.fn().mockResolvedValue([]),
    loadEditorSettings: vi.fn().mockResolvedValue(null),
    loadPinnedTreeNodeIds: vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    loadTunnelProfiles: vi.fn().mockResolvedValue([]),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveEditorSettings: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    loadSidebarLayout: vi.fn().mockResolvedValue(null),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    sessionCredentialStatus: vi.fn().mockResolvedValue(false),
    forgetSessionCredential: vi.fn().mockResolvedValue(undefined),
  }));
  // Result-snapshot cleanup hits a relative URL, which node's fetch rejects outright.
  // Unrelated to what these cases assert.
  vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
    return { ...actual, deleteTabResultSnapshotsForOwner: vi.fn().mockResolvedValue(undefined) };
  });
}

function previewConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "preview-1",
    name: "[Preview] sales.parquet",
    db_type: "duckdb",
    host: ":memory:",
    port: 0,
    username: "",
    password: "",
    one_time: true,
    ...overrides,
  } as ConnectionConfig;
}

describe("connectionStore one_time runtime cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // One-time connections are never persisted, so the backend's save_connections
  // sync never reclaims them; disconnect_db is the only reclaim point, which makes
  // an explicit disconnect on removal mandatory.
  it("removeConnection disconnects a one_time connection so the backend can reclaim it", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [previewConnection()];

    await store.removeConnection("preview-1");

    const { disconnectDb } = await import("@/lib/backend/api");
    // No clientAttempt: removal is terminal, so a superseded attempt number must not
    // skip the cleanup.
    expect(disconnectDb).toHaveBeenCalledWith("preview-1");
  });

  it("initFromDisk preserves an open one_time connection during a persisted-list reload", async () => {
    installApiMocks();
    const { loadConnections } = await import("@/lib/backend/api");
    vi.mocked(loadConnections).mockResolvedValue([previewConnection({ id: "saved-1", name: "Saved", one_time: false })]);
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [previewConnection({ id: "deeplink-1", name: "Deeplink", one_time: true })];

    await store.initFromDisk();

    expect(store.connections.map((connection) => connection.id)).toEqual(["saved-1", "deeplink-1"]);
    expect(store.getConfig("deeplink-1")).toMatchObject({ name: "Deeplink", one_time: true });
  });

  it("does not retain a stale saved connection removed from persisted storage", async () => {
    installApiMocks();
    const { loadConnections } = await import("@/lib/backend/api");
    vi.mocked(loadConnections).mockResolvedValue([]);
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [previewConnection({ id: "removed-1", name: "Removed", one_time: false })];

    await store.initFromDisk();

    expect(store.getConfig("removed-1")).toBeUndefined();
    expect(store.connections).toEqual([]);
  });

  it("removeConnection leaves saved connections to the save_connections sync", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [previewConnection({ id: "saved-1", one_time: false })];

    await store.removeConnection("saved-1");

    const { disconnectDb } = await import("@/lib/backend/api");
    expect(disconnectDb).not.toHaveBeenCalled();
  });

  // The connection is gone for good, so its tabs can never reconnect: executing in
  // one would fail with "Connection config not found".
  it("removeConnection closes the tabs of a one_time connection", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useConnectionStore();
    const queryStore = useQueryStore();
    store.connections = [previewConnection()];
    const queryId = queryStore.createTab("preview-1", "", "sales.parquet", "query");
    queryStore.updateSql(queryId, "select 1;");
    expect(queryStore.tabs.some((tab) => tab.connectionId === "preview-1")).toBe(true);

    await store.removeConnection("preview-1");

    expect(queryStore.tabs.some((tab) => tab.connectionId === "preview-1")).toBe(false);
    expect(queryStore.showCloseConfirm).toBe(false);
  });

  it("deleteConnectionGroups closes the tabs of removed one_time connections", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useConnectionStore();
    const queryStore = useQueryStore();
    const layout: SidebarLayout = {
      groups: [{ id: "group-1", name: "Group", collapsed: false }],
      order: [{ type: "group", id: "group-1", children: [{ type: "connection", id: "preview-1" }] }],
    };
    store.connections = [previewConnection()];
    store.sidebarLayout = layout;
    queryStore.createTab("preview-1", "", "sales.parquet", "query");

    await store.deleteConnectionGroups(["group-1"], true);

    const { disconnectDb } = await import("@/lib/backend/api");
    expect(disconnectDb).toHaveBeenCalledWith("preview-1");
    expect(queryStore.tabs.some((tab) => tab.connectionId === "preview-1")).toBe(false);
  });

  it("removeConnection keeps the tabs of a saved connection for the disconnect handling mode", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useConnectionStore();
    const queryStore = useQueryStore();
    store.connections = [previewConnection({ id: "saved-1", one_time: false })];
    queryStore.createTab("saved-1", "", "query.sql", "query");

    await store.removeConnection("saved-1");

    expect(queryStore.tabs.some((tab) => tab.connectionId === "saved-1")).toBe(true);
  });
});
