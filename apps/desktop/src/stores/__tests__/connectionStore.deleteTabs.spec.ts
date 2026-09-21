import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

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
    saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
    loadOpenTabsState: vi.fn().mockResolvedValue(null),
    // 关闭页签会顺带回收结果/客户端会话；缺失的导出会让清理路径报错刷屏。
    closeQuerySession: vi.fn().mockResolvedValue(undefined),
    closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    sessionCredentialStatus: vi.fn().mockResolvedValue(false),
    forgetSessionCredential: vi.fn().mockResolvedValue(undefined),
  }));
  // Result-snapshot cleanup hits a relative URL, which node's fetch rejects outright.
  vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
    return { ...actual, deleteTabResultSnapshotsForOwner: vi.fn().mockResolvedValue(undefined) };
  });
}

function pgConnection(id: string, name: string, database?: string): ConnectionConfig {
  return {
    id,
    name,
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database,
    read_only: false,
  } as ConnectionConfig;
}

describe("connectionStore delete-time tab handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keep-sql-tabs keeps SQL tabs, closes object tabs, and remembers the database", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.deleteConnectionTabHandlingMode = "keep-sql-tabs";
    settingsStore.editorSettings.rememberConnectionDatabaseOnDelete = true;

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const sqlId = queryStore.createTab("conn-a", "app", "draft.sql", "query");
    const dataId = queryStore.createTab("conn-a", "app", "users", "data", "public", undefined, undefined, { forceNew: true });

    await store.removeConnection("conn-a");

    expect(queryStore.tabs.some((tab) => tab.id === sqlId)).toBe(true);
    expect(queryStore.tabs.some((tab) => tab.id === dataId)).toBe(false);
    const kept = queryStore.tabs.find((tab) => tab.id === sqlId);
    // 页签仍指向已删除的连接，但记录了原连接名，供新建同名连接重绑。
    expect(kept?.connectionId).toBe("conn-a");
    expect(kept?.detachedConnectionName).toBe("prod");
    expect(settingsStore.editorSettings.rememberedConnectionDatabases.prod).toEqual({ database: "app", dbType: "postgres" });
  });

  it("keep-pinned-sql-tabs keeps pinned SQL tabs only", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.deleteConnectionTabHandlingMode = "keep-pinned-sql-tabs";

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const pinnedId = queryStore.createTab("conn-a", "app", "pinned.sql", "query");
    const plainId = queryStore.createTab("conn-a", "app", "plain.sql", "query");
    const dataId = queryStore.createTab("conn-a", "app", "users", "data", "public", undefined, undefined, { forceNew: true });
    queryStore.togglePinnedTab(pinnedId);

    await store.removeConnection("conn-a");

    expect(queryStore.tabs.map((tab) => tab.id)).toEqual([pinnedId]);
    expect(queryStore.tabs.some((tab) => tab.id === plainId)).toBe(false);
    expect(queryStore.tabs.some((tab) => tab.id === dataId)).toBe(false);
  });

  it("does not remember or detach tabs when the memory switch is off", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.deleteConnectionTabHandlingMode = "keep-sql-tabs";
    settingsStore.editorSettings.rememberConnectionDatabaseOnDelete = false;

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const sqlId = queryStore.createTab("conn-a", "app", "draft.sql", "query");

    await store.removeConnection("conn-a");

    const kept = queryStore.tabs.find((tab) => tab.id === sqlId);
    expect(kept?.detachedConnectionName).toBeUndefined();
    expect(settingsStore.editorSettings.rememberedConnectionDatabases).toEqual({});
  });

  it("rebinds kept SQL tabs and reuses the remembered database when a same-named connection is created", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.deleteConnectionTabHandlingMode = "keep-sql-tabs";
    settingsStore.editorSettings.rememberConnectionDatabaseOnDelete = true;

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const defaultDbTab = queryStore.createTab("conn-a", "app", "draft.sql", "query");
    // 页签可能指向该连接下的另一个库，重绑不应改写它的执行上下文。
    const otherDbTab = queryStore.createTab("conn-a", "reporting", "report.sql", "query");
    const noDbTab = queryStore.createTab("conn-a", "", "scratch.sql", "query");

    await store.removeConnection("conn-a");
    expect(queryStore.tabs.some((tab) => tab.id === defaultDbTab)).toBe(true);

    // 新建同名连接（表单未填数据库）时，回填记住的数据库并把脱离页签重绑过来。
    await store.addConnection(pgConnection("conn-b", "prod"));

    expect(store.getConfig("conn-b")?.database).toBe("app");
    const rebound = queryStore.tabs.find((tab) => tab.id === defaultDbTab);
    expect(rebound?.connectionId).toBe("conn-b");
    expect(rebound?.database).toBe("app");
    expect(rebound?.detachedConnectionName).toBeUndefined();
    expect(queryStore.tabs.find((tab) => tab.id === otherDbTab)).toMatchObject({ connectionId: "conn-b", database: "reporting" });
    // 页签没有库时才回落到新连接的默认库。
    expect(queryStore.tabs.find((tab) => tab.id === noDbTab)).toMatchObject({ connectionId: "conn-b", database: "app" });
  });

  it("still asks before discarding an unsaved SQL draft when the policy closes tabs", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.deleteConnectionTabHandlingMode = "close-tabs";

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const dirtyId = queryStore.createTab("conn-a", "app", "draft.sql", "query");
    queryStore.updateSql(dirtyId, "select 1;");

    await store.removeConnection("conn-a");

    // 删除连接不能静默丢掉未保存的草稿：先弹保存/放弃确认，而不是直接关掉。
    expect(queryStore.showCloseConfirm).toBe(true);
    expect(queryStore.pendingCloseTabId).toBe(dirtyId);

    // 用户在确认框里选择取消时页签会留下，此时它仍带着原连接名，可被新建的同名连接接管。
    expect(queryStore.tabs.find((tab) => tab.id === dirtyId)?.detachedConnectionName).toBe("prod");

    queryStore.forceCloseAllPendingTabs();
    expect(queryStore.tabs.some((tab) => tab.id === dirtyId)).toBe(false);
  });

  it("does not reuse the remembered database for a same-named connection of another type", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.deleteConnectionTabHandlingMode = "keep-sql-tabs";
    settingsStore.editorSettings.rememberConnectionDatabaseOnDelete = true;

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "test", "app")];
    const queryStore = useQueryStore();
    const sqlId = queryStore.createTab("conn-a", "app", "draft.sql", "query");
    await store.removeConnection("conn-a");

    // "test" 这类名字常被不同数据库类型复用；跨类型回填会把无意义的库名写进新连接配置。
    await store.addConnection({ ...pgConnection("conn-b", "test"), db_type: "sqlite", driver_profile: "sqlite" } as ConnectionConfig);

    expect(store.getConfig("conn-b")?.database).toBeUndefined();
    // 页签重绑只看连接名，与类型无关。
    expect(queryStore.tabs.find((tab) => tab.id === sqlId)?.connectionId).toBe("conn-b");
  });

  it("asks before discarding an unsaved structure draft when only SQL tabs are kept", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.deleteConnectionTabHandlingMode = "keep-sql-tabs";

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const sqlId = queryStore.createTab("conn-a", "app", "kept.sql", "query");
    const structureId = queryStore.createTab("conn-a", "app", "users", "structure", "public", undefined, undefined, { forceNew: true });
    const structureTab = queryStore.tabs.find((tab) => tab.id === structureId);
    if (!structureTab) throw new Error("structure tab was not created");
    structureTab.structureDraft = { dirty: true } as never;

    await store.removeConnection("conn-a");

    // SQL 页签按策略保留；未保存的表结构草稿仍要先确认，不能静默丢弃。
    expect(queryStore.tabs.some((tab) => tab.id === sqlId)).toBe(true);
    expect(queryStore.showCloseConfirm).toBe(true);
    expect(queryStore.pendingCloseTabId).toBe(structureId);
  });

  it("keep-all-tabs closes nothing and keeps the current results", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.deleteConnectionTabHandlingMode = "keep-all-tabs";

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const sqlId = queryStore.createTab("conn-a", "app", "kept.sql", "query");
    const dataId = queryStore.createTab("conn-a", "app", "users", "data", "public", undefined, undefined, { forceNew: true });
    const sqlTab = queryStore.tabs.find((tab) => tab.id === sqlId);
    if (!sqlTab) throw new Error("query tab was not created");
    sqlTab.result = { columns: [], rows: [] } as never;

    await store.removeConnection("conn-a");

    // 连表格页签也保留，且结果不被清空（对应断开设置里的「不关闭相关页签」）。
    expect(queryStore.tabs.map((tab) => tab.id)).toEqual([sqlId, dataId]);
    expect(queryStore.tabs.find((tab) => tab.id === sqlId)?.result).toBeDefined();
    expect(queryStore.tabs.find((tab) => tab.id === sqlId)?.detachedConnectionName).toBe("prod");
    expect(queryStore.showCloseConfirm).toBe(false);
  });

  it("reproduces the reported flow: keep-all-tabs set through the real settings write path", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settingsStore = useSettingsStore();
    // 走设置面板真实使用的写入路径（而不是直接改字段），确保草稿/patch/归一化链路都覆盖。
    settingsStore.updateEditorSettings({ deleteConnectionTabHandlingMode: "keep-all-tabs", rememberConnectionDatabaseOnDelete: true });
    expect(settingsStore.editorSettings.deleteConnectionTabHandlingMode).toBe("keep-all-tabs");

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const sqlId = queryStore.createTab("conn-a", "app", "draft.sql", "query");
    queryStore.updateSql(sqlId, "select 1;");

    // 真实删除流程：removeConnections 应用删除策略，随后 disconnect 只清会话。
    await store.removeConnections(["conn-a"]);
    await store.disconnect("conn-a", { skipTabHandling: true });

    expect(queryStore.tabs.some((tab) => tab.id === sqlId)).toBe(true);
    expect(queryStore.tabs.find((tab) => tab.id === sqlId)?.connectionId).toBe("conn-a");
  });

  it("keeps tabs untouched when a new connection has a different name", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.deleteConnectionTabHandlingMode = "keep-sql-tabs";

    const store = useConnectionStore();
    store.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const sqlId = queryStore.createTab("conn-a", "app", "draft.sql", "query");
    await store.removeConnection("conn-a");

    await store.addConnection(pgConnection("conn-b", "staging"));

    const orphan = queryStore.tabs.find((tab) => tab.id === sqlId);
    expect(orphan?.connectionId).toBe("conn-a");
    expect(orphan?.detachedConnectionName).toBe("prod");
  });
});
