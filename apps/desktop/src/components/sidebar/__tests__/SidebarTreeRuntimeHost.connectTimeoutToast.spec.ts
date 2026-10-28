// @vitest-environment happy-dom

// issue #13233：侧边栏连接/取数失败时，若错误属于「连接超时」，失败 toast 必须附带
// 「修改超时时间」动作；点击动作后经 open-connection-settings 事件抛出连接 ID（由
// App.vue 打开该连接的编辑对话框高级页）。非超时错误保持原有纯提示行为（无动作）。
import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";

const connectionStore = {
  treeNodes: [] as TreeNode[],
  selectedTreeNodeIds: [] as string[],
  sidebarSearchQuery: "",
  activeConnectionId: null as string | null,
  connectedIds: new Set<string>(),
  canUseLoadedTreeNodeToggle: vi.fn(() => true),
  releaseCollapsedTreeNodeChildren: vi.fn(),
  getConfig: vi.fn(() => ({ db_type: "mysql", name: "connection" })),
  ensureConnected: vi.fn(async () => undefined),
  // 数据库节点展开即触发连接/建表清单加载；由用例注入超时或普通错误。
  loadTables: vi.fn(async () => undefined),
  loadDatabases: vi.fn(async () => undefined),
};

const queryStore = {
  openObjectBrowser: vi.fn(),
  createTab: vi.fn(),
};

const toast = vi.fn();

const settingsStore = {
  editorSettings: {
    sidebarActivation: "single" as "single" | "double",
    sidebarBrowseObjectsOnDatabaseActivation: false,
    shortcuts: { openDataInNewTab: "" },
  },
};

vi.mock("@/stores/connectionStore", () => ({
  CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "Connection attempt was cancelled",
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => queryStore }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => settingsStore }));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({}) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: vi.fn() }) }));
vi.mock("@/composables/useSidebarDataOpenRuntime", () => ({ useSidebarDataOpenRuntime: () => ({ openData: vi.fn() }) }));
vi.mock("@/composables/useDatabaseOptions", () => ({ useDatabaseOptions: () => ({ getDatabaseOptions: vi.fn() }) }));
vi.mock("@/composables/useSidebarConnectionMutationRuntime", () => ({ useSidebarConnectionMutationRuntime: () => ({ isPinned: ref(false) }) }));
vi.mock("@/composables/useSidebarDatabaseSpecificMutationRuntime", () => ({
  useSidebarDatabaseSpecificMutationRuntime: () => ({
    canManageMongoIndexes: ref(false),
    canRenameMongoCollection: ref(false),
    canCloneMongoCollection: ref(false),
    canDropMongoCollection: ref(false),
  }),
}));
vi.mock("@/composables/useSidebarTableMutationRuntime", () => ({ useSidebarTableMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeExportRuntime", () => ({ useSidebarTreeExportRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeToolRuntime", () => ({ useSidebarTreeToolRuntime: () => ({}) }));
vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...actual, listPlugins: vi.fn().mockResolvedValue([]) };
});

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  connectionStore.treeNodes = [];
  connectionStore.sidebarSearchQuery = "";
  connectionStore.activeConnectionId = null;
  connectionStore.connectedIds.clear();
  settingsStore.editorSettings.sidebarBrowseObjectsOnDatabaseActivation = false;
  vi.clearAllMocks();
  connectionStore.canUseLoadedTreeNodeToggle.mockReturnValue(true);
  connectionStore.getConfig.mockReturnValue({ db_type: "mysql", name: "connection" });
  connectionStore.loadTables.mockResolvedValue(undefined);
  connectionStore.loadDatabases.mockResolvedValue(undefined);
});

// 挂载宿主并让 database 节点展开失败（loadTables/loadDatabases 抛出用例注入的错误），
// 返回捕获 open-connection-settings 事件的监听器，供动作点击断言使用。
async function mountAndFailExpand(error: unknown, openConnectionSettings: (connectionId: string) => void) {
  const database: TreeNode = {
    id: "mysql:dbx_test",
    label: "dbx_test",
    type: "database",
    connectionId: "mysql",
    database: "dbx_test",
    isExpanded: false,
    children: [],
  };
  connectionStore.treeNodes = [database];
  connectionStore.loadTables.mockRejectedValue(error);
  connectionStore.loadDatabases.mockRejectedValue(error);
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const app = createApp(
    defineComponent({
      setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: database, depth: 0, onOpenConnectionSettings: openConnectionSettings }),
    }),
  );
  mountedApps.push(app);
  const container = document.createElement("div");
  document.body.append(container);
  app.use(i18n);
  app.mount(container);

  host.value!.toggleNode(database);
  await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce());
  return toast.mock.calls[0] as [string, number, { label: string; onClick: () => void } | undefined];
}

describe("SidebarTreeRuntimeHost connect-failed toast timeout action", () => {
  it("adds a change-timeout action when the expand failure is a connection timeout", async () => {
    const openConnectionSettings = vi.fn();
    const [message, duration, action] = await mountAndFailExpand(new Error("Connection attempt timed out: handshake failed"), openConnectionSettings);

    expect(duration).toBe(5000);
    expect(message).toContain(i18n.global.t("connection.connectFailed", { message: "Connection attempt timed out: handshake failed" }));
    expect(action?.label).toBe(i18n.global.t("editor.changeConnectionTimeout"));

    action!.onClick();
    expect(openConnectionSettings).toHaveBeenCalledExactlyOnceWith("mysql");
  });

  it("keeps the plain toast without action for non-timeout failures", async () => {
    const openConnectionSettings = vi.fn();
    const [, duration, action] = await mountAndFailExpand(new Error("Access denied for user 'dbx'"), openConnectionSettings);

    expect(duration).toBe(5000);
    expect(action).toBeUndefined();
    expect(openConnectionSettings).not.toHaveBeenCalled();
  });
});
