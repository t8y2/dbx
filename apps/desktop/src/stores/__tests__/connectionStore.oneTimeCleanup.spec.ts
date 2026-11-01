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
    loadTableVGroups: vi.fn().mockResolvedValue({}),
    saveTableVGroups: vi.fn().mockResolvedValue(undefined),
    deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
    // 关闭页签会顺带回收结果/客户端会话；缺失的导出会让清理路径报错刷屏。
    closeQuerySession: vi.fn().mockResolvedValue(undefined),
    closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
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

  it("cancels source and target schema compares and drains metadata before disconnecting pools", async () => {
    installApiMocks();
    const { registerSchemaDiffTask } = await import("@/lib/schema/schemaDiffCancellation");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { disconnectDb } = await import("@/lib/backend/api");
    const store = useConnectionStore();
    store.connections = [previewConnection({ id: "saved-1", one_time: false })];
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const finish: Array<() => void> = [];
    for (const [i, ids] of [
      ["saved-1", "target"],
      ["source", "saved-1"],
      ["other", "target"],
    ].entries()) {
      registerSchemaDiffTask(ids, controllers[i], new Promise<void>((resolve) => finish.push(resolve)));
    }
    const disconnecting = store.disconnect("saved-1");
    expect(controllers.map((controller) => controller.signal.aborted)).toEqual([true, true, false]);
    expect(disconnectDb).not.toHaveBeenCalled();
    finish[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disconnectDb).not.toHaveBeenCalled();
    finish[1]();
    await disconnecting;
    expect(disconnectDb).toHaveBeenCalledOnce();
    expect(disconnectDb).toHaveBeenCalledWith("saved-1", undefined);
    finish[2]();
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

  it("retains the response-only dialect identity when loading saved connections", async () => {
    installApiMocks();
    const { loadConnections } = await import("@/lib/backend/api");
    const { effectiveDatabaseTypeForConnection } = await import("@/lib/database/jdbcDialect");
    const saved = previewConnection({
      id: "jdbc-oracle-mode",
      one_time: false,
      db_type: "jdbc",
      connection_string: "__DBX_SAVED_CREDENTIAL__:opaque",
      jdbc_dialect: "oceanbase-oracle",
    });
    vi.mocked(loadConnections).mockResolvedValue([saved]);
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();

    await store.initFromDisk();

    expect(store.getConfig(saved.id)?.jdbc_dialect).toBe("oceanbase-oracle");
    expect(effectiveDatabaseTypeForConnection(store.getConfig(saved.id))).toBe("oceanbase-oracle");
  });

  it("does not let an in-flight connection response replace an edit made after the load began", async () => {
    installApiMocks();
    const { loadConnections } = await import("@/lib/backend/api");
    let finishLoad!: (connections: ConnectionConfig[]) => void;
    vi.mocked(loadConnections).mockReturnValueOnce(
      new Promise((resolve) => {
        finishLoad = resolve;
      }),
    );
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const saved = previewConnection({
      id: "jdbc-oracle-mode",
      one_time: false,
      db_type: "jdbc",
      connection_string: "__DBX_SAVED_CREDENTIAL__:opaque",
      jdbc_dialect: "oceanbase-oracle",
    });
    store.connections = [saved];

    const loading = store.initFromDisk();
    await vi.waitFor(() => expect(loadConnections).toHaveBeenCalledOnce());
    const edited = { ...saved, connection_string: "jdbc:oracle:thin:@host/service", jdbc_dialect: undefined };
    store.connections = [edited];
    finishLoad([saved]);
    await loading;

    expect(store.getConfig(saved.id)?.connection_string).toBe(edited.connection_string);
    expect(store.getConfig(saved.id)?.jdbc_dialect).toBeUndefined();
    const { effectiveDatabaseTypeForConnection } = await import("@/lib/database/jdbcDialect");
    expect(effectiveDatabaseTypeForConnection(store.getConfig(saved.id))).toBe("oracle");
  });

  it("does not reconnect for response-only dialect changes and omits the hint from saves", async () => {
    installApiMocks();
    const { saveConnections } = await import("@/lib/backend/api");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = previewConnection({
      id: "jdbc-oracle-mode",
      one_time: false,
      db_type: "jdbc",
      connection_string: "__DBX_SAVED_CREDENTIAL__:opaque",
      jdbc_dialect: "oceanbase-oracle",
    });
    store.connections = [connection];
    store.connectedIds.add(connection.id);

    await store.updateConnection({ ...connection, jdbc_dialect: undefined });

    expect(store.connectedIds.has(connection.id)).toBe(true);
    const { effectiveDatabaseTypeForConnection } = await import("@/lib/database/jdbcDialect");
    expect(effectiveDatabaseTypeForConnection(store.getConfig(connection.id))).toBe("oceanbase-oracle");
    expect(saveConnections).toHaveBeenCalledOnce();
    const savedConfigs = vi.mocked(saveConnections).mock.calls[0]![0];
    expect(savedConfigs[0]).not.toHaveProperty("jdbc_dialect");
  });

  it.each(["rename", "replace-url", "clear-url", "replace-reference"])("keeps a saved JDBC dialect only for the unchanged protected URL (%s)", async (edit) => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { effectiveDatabaseTypeForConnection } = await import("@/lib/database/jdbcDialect");
    const { saveConnections } = await import("@/lib/backend/api");
    const store = useConnectionStore();
    const saved = previewConnection({ id: "jdbc-mode", name: "Saved", one_time: false, db_type: "jdbc", driver_profile: "jdbc", driver_label: "JDBC", jdbc_driver_class: "com.oceanbase.jdbc.Driver", connection_string: "__DBX_SAVED_CREDENTIAL__:original", jdbc_dialect: "oceanbase-oracle" });
    store.connections = [saved];
    const { jdbc_dialect: _hint, ...form } = saved;
    const url = edit === "replace-url" ? "jdbc:oracle:thin:@host/service" : edit === "clear-url" ? "" : edit === "replace-reference" ? "__DBX_SAVED_CREDENTIAL__:other" : saved.connection_string;
    await store.updateConnection({ ...form, name: "Renamed", connection_string: url });
    expect(effectiveDatabaseTypeForConnection(store.getConfig(saved.id))).toBe(edit === "rename" ? "oceanbase-oracle" : edit === "replace-url" ? "oracle" : "jdbc");
    expect(vi.mocked(saveConnections).mock.calls.at(-1)![0][0]).not.toHaveProperty("jdbc_dialect");
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

  it("reloads externally added, copied and deleted connections while preserving existing tree state", async () => {
    installApiMocks();
    const { loadConnections } = await import("@/lib/backend/api");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const kept = previewConnection({ id: "kept", one_time: false });
    const temporary = previewConnection({ id: "temporary" });
    store.connections = [kept, previewConnection({ id: "removed", one_time: false }), temporary];
    store.connectedIds.add("kept");
    store.treeNodes = [{ id: "kept", label: kept.name, type: "connection", connectionId: "kept", isExpanded: true, children: [{ id: "kept:app", label: "app", type: "database", connectionId: "kept", database: "app", isExpanded: true }] }];
    vi.mocked(loadConnections).mockResolvedValue([kept, previewConnection({ id: "added", one_time: false }), previewConnection({ id: "copied", one_time: false })]);

    await store.reloadFromDisk();

    expect(store.connections.map((connection) => connection.id)).toEqual(["kept", "added", "copied", "temporary"]);
    expect(store.treeNodes.map((node) => node.id)).toEqual(["kept", "added", "copied", "temporary"]);
    expect(store.treeNodes[0]).toMatchObject({ isExpanded: true, children: expect.arrayContaining([expect.objectContaining({ id: "kept:app", isExpanded: true })]) });
    expect(store.connectedIds.has("kept")).toBe(true);
  });

  it("reads a fresh snapshot when an external change arrives during an in-flight reload", async () => {
    installApiMocks();
    const { loadConnections } = await import("@/lib/backend/api");
    let finishFirstRead!: (connections: ConnectionConfig[]) => void;
    vi.mocked(loadConnections)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirstRead = resolve;
        }),
      )
      .mockResolvedValueOnce([previewConnection({ id: "new", one_time: false })]);
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const initialLoad = store.initFromDisk();
    await vi.waitFor(() => expect(loadConnections).toHaveBeenCalledOnce());
    const externalReload = store.reloadFromDisk();
    finishFirstRead([]);
    await Promise.all([initialLoad, externalReload]);

    expect(loadConnections).toHaveBeenCalledTimes(2);
    expect(store.getConfig("new")).toBeDefined();
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

  // 删除连接是终态，页签一律由「删除连接」策略决定，one_time 连接也不例外——它的页签虽然
  // 无法再执行，但里面的 SQL 文本是用户的工作。默认 close-tabs 仍会关闭页签，只是未保存的
  // 草稿必须先经保存/放弃确认，不能像以前那样被静默丢弃。
  it("removeConnection asks before discarding an unsaved SQL draft of a one_time connection", async () => {
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

    expect(queryStore.showCloseConfirm).toBe(true);
    expect(queryStore.pendingCloseTabId).toBe(queryId);

    queryStore.forceCloseAllPendingTabs();
    expect(queryStore.tabs.some((tab) => tab.connectionId === "preview-1")).toBe(false);
  });

  it("removeConnection keeps the SQL tabs of a one_time connection when the policy says so", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ deleteConnectionTabHandlingMode: "keep-all-tabs" });
    const store = useConnectionStore();
    const queryStore = useQueryStore();
    store.connections = [previewConnection()];
    const queryId = queryStore.createTab("preview-1", "", "sales.parquet", "query");
    queryStore.updateSql(queryId, "select 1;");

    await store.removeConnection("preview-1");

    expect(queryStore.tabs.some((tab) => tab.id === queryId)).toBe(true);
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

  // 删除连接是终态（配置已从磁盘移除、无法重连），因此页签由「删除连接」策略决定，
  // 不再复用「断开连接」策略。默认 close-tabs：删除即关闭该连接的页签。
  it("removeConnection applies the delete tab handling mode to a saved connection", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useConnectionStore();
    const queryStore = useQueryStore();
    store.connections = [previewConnection({ id: "saved-1", one_time: false })];
    queryStore.createTab("saved-1", "", "query.sql", "query");

    await store.removeConnection("saved-1");

    expect(queryStore.tabs.some((tab) => tab.connectionId === "saved-1")).toBe(false);
  });
});
