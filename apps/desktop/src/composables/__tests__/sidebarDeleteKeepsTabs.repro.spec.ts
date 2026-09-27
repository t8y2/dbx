import { createPinia, setActivePinia } from "pinia";
import { shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

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
    closeQuerySession: vi.fn().mockResolvedValue(undefined),
    closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    sessionCredentialStatus: vi.fn().mockResolvedValue(false),
    forgetSessionCredential: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
    return { ...actual, deleteTabResultSnapshotsForOwner: vi.fn().mockResolvedValue(undefined) };
  });
}

function pgConnection(id: string, name: string, database?: string): ConnectionConfig {
  return { id, name, db_type: "postgres", host: "127.0.0.1", port: 5432, username: "postgres", password: "", database, read_only: false } as ConnectionConfig;
}

function connectionNode(connectionId: string): TreeNode {
  return { id: connectionId, label: connectionId, type: "connection", connectionId, isExpanded: false, children: [] };
}

describe("删除连接的真实侧边栏流程", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    installLocalStorage();
    installApiMocks();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keep-all-tabs：走 confirmDelete 后 SQL 页签仍在", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { useSidebarConnectionMutationRuntime } = await import("@/composables/useSidebarConnectionMutationRuntime");
    const { showDeleteConfirm } = await import("@/components/sidebar/sidebarTreeDialogState");

    const settingsStore = useSettingsStore();
    settingsStore.updateEditorSettings({ deleteConnectionTabHandlingMode: "keep-all-tabs", rememberConnectionDatabaseOnDelete: true });

    const connectionStore = useConnectionStore();
    connectionStore.connections = [pgConnection("conn-a", "prod", "app")];
    const queryStore = useQueryStore();
    const sqlId = queryStore.createTab("conn-a", "app", "draft.sql", "query");
    queryStore.updateSql(sqlId, "select 1;");

    const node = connectionNode("conn-a");
    const runtime = useSidebarConnectionMutationRuntime({
      activeNode: shallowRef(node),
      releaseActiveNodeReference: vi.fn(),
      selectedTreeNodesInVisibleOrder: () => [node],
      connectionStore,
      queryStore,
      requestGroupRename: vi.fn(),
      openVisibleDatabases: vi.fn(),
      openVisibleSchemas: vi.fn(),
    } as never);

    runtime.deleteConnection();
    expect(showDeleteConfirm.value).toBe(true);
    await runtime.confirmDelete();

    expect(connectionStore.connections.some((c) => c.id === "conn-a")).toBe(false);
    expect(queryStore.tabs.some((tab) => tab.id === sqlId)).toBe(true);
    expect(settingsStore.editorSettings.rememberedConnectionDatabases.prod).toEqual({ database: "app", dbType: "postgres" });
  });
});
