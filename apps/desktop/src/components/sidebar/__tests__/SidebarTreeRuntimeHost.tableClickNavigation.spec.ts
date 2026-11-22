// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";

const connectionStore = {
  treeNodes: [] as TreeNode[],
  sidebarSearchQuery: "",
  activeConnectionId: null as string | null,
  connectedIds: new Set<string>(),
  selectedTreeNodeId: null as string | null,
  selectedTreeNodeIds: [] as string[],
  treeSelectionAnchorId: null as string | null,
  connectionMultiSelectActive: false,
  get selectedTreeNodeIdsSet(): Set<string> {
    return new Set(this.selectedTreeNodeIds);
  },
  getConfig: vi.fn(() => ({ db_type: "postgres", name: "connection" })),
};
const queryStore = { tabs: [] as any[], switchTab: vi.fn(), createTab: vi.fn() };
const settings = { sidebarActivation: "single", sidebarTableClickNavigation: true, sidebarBrowseObjectsOnDatabaseActivation: false, dataTabReuseMode: "same-table", shortcuts: { openDataInNewTab: "" } };
const supersede = vi.hoisted(() => vi.fn());
const openData = vi.fn();

vi.mock("@/stores/connectionStore", () => ({ CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "connection attempt cancelled", useConnectionStore: () => connectionStore }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => queryStore }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: settings }) }));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({}) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: vi.fn() }) }));
vi.mock("@/composables/useSidebarDataOpenRuntime", () => ({ useSidebarDataOpenRuntime: () => ({ openData }) }));
vi.mock("@/composables/useDatabaseOptions", () => ({ useDatabaseOptions: () => ({ getDatabaseOptions: vi.fn() }) }));
vi.mock("@/composables/useSidebarConnectionMutationRuntime", () => ({ useSidebarConnectionMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarDatabaseSpecificMutationRuntime", () => ({ useSidebarDatabaseSpecificMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTableMutationRuntime", () => ({ useSidebarTableMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeExportRuntime", () => ({ useSidebarTreeExportRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeToolRuntime", () => ({ useSidebarTreeToolRuntime: () => ({}) }));
vi.mock("@/lib/sidebar/sidebarDataOpenCoordinator", () => ({ supersedeSidebarDataNavigation: supersede }));

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  queryStore.tabs = [];
  connectionStore.treeNodes = [];
  connectionStore.selectedTreeNodeId = null;
  settings.sidebarTableClickNavigation = true;
  vi.clearAllMocks();
  connectionStore.getConfig.mockReturnValue({ db_type: "postgres", name: "connection" });
});

async function mount(node: TreeNode) {
  connectionStore.treeNodes = [node];
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const onOpenData = vi.fn();
  const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node, depth: 0, onOpenData }) }));
  app.use(i18n);
  apps.push(app);
  const container = document.createElement("div");
  document.body.appendChild(container);
  app.mount(container);
  await nextTick();
  return { host: host.value!, onOpenData };
}

describe("SidebarTreeRuntimeHost table click navigation", () => {
  const node: TreeNode = { id: "conn:app:public:orders", type: "table", label: "orders", connectionId: "conn", database: "app", schema: "public" };

  it("switches to the matching data tab using the rendered node's full identity", async () => {
    queryStore.tabs = [
      { id: "wrong-schema", mode: "data", connectionId: "conn", database: "app", schema: "other", title: "orders" },
      { id: "match", mode: "data", connectionId: "conn", database: "app", schema: "public", title: "orders" },
    ];
    const { host, onOpenData } = await mount(node);
    host.handleRowClick(node, 1, true);
    expect(supersede).toHaveBeenCalledExactlyOnceWith(node.id);
    expect(queryStore.switchTab).toHaveBeenCalledExactlyOnceWith("match");
    expect(onOpenData).not.toHaveBeenCalled();
  });

  it("switches to an existing HBase tab using its SQL table name", async () => {
    connectionStore.getConfig.mockReturnValue({ db_type: "hbase", name: "connection" });
    queryStore.tabs = [
      { id: "wrong-mode", mode: "data", connectionId: "conn", database: "app", title: "orders" },
      { id: "hbase", mode: "hbase", connectionId: "conn", database: "app", title: "display name", sql: "orders" },
    ];
    const { host, onOpenData } = await mount(node);
    host.handleRowClick(node, 1, true);
    expect(supersede).toHaveBeenCalledExactlyOnceWith(node.id);
    expect(queryStore.switchTab).toHaveBeenCalledExactlyOnceWith("hbase");
    expect(onOpenData).not.toHaveBeenCalled();
  });

  it("leaves the selected row without opening a tab when no table matches", async () => {
    queryStore.tabs = [{ id: "other", mode: "data", connectionId: "conn", database: "app", schema: "public", title: "customers" }];
    connectionStore.selectedTreeNodeId = node.id; // TreeItem selects the row before calling the host.
    const { host, onOpenData } = await mount(node);
    host.handleRowClick(node, 1, true);
    expect(connectionStore.selectedTreeNodeId).toBe(node.id);
    expect(supersede).toHaveBeenCalledExactlyOnceWith(node.id);
    expect(queryStore.switchTab).not.toHaveBeenCalled();
    expect(queryStore.createTab).not.toHaveBeenCalled();
    expect(onOpenData).not.toHaveBeenCalled();
    expect(openData).not.toHaveBeenCalled();
  });

  it("preserves the search Enter action when the pointer-only argument is absent", async () => {
    const { host, onOpenData } = await mount(node);
    host.handleRowClick(node, 1);
    expect(onOpenData).toHaveBeenCalledExactlyOnceWith(node, true, "default", openData);
    expect(supersede).not.toHaveBeenCalled();
    expect(queryStore.switchTab).not.toHaveBeenCalled();
  });

  it("preserves the usual click action when navigation is disabled", async () => {
    settings.sidebarTableClickNavigation = false;
    const { host, onOpenData } = await mount(node);
    host.handleRowClick(node, 1, true);
    expect(onOpenData).toHaveBeenCalledExactlyOnceWith(node, true, "default", openData);
    expect(supersede).not.toHaveBeenCalled();
  });
});
