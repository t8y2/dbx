// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";
import { syncSidebarTreeNodeExpansion } from "@/lib/sidebar/sidebarTreeExpansion";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";

const connectionStore = {
  treeNodes: [] as TreeNode[],
  sidebarSearchQuery: "",
  canUseLoadedTreeNodeToggle: vi.fn(() => true),
  releaseCollapsedTreeNodeChildren: vi.fn(),
  getConfig: vi.fn(() => ({ db_type: "mysql", name: "connection" })),
  ensureConnected: vi.fn(async () => undefined),
  loadPackageMembers: vi.fn(async (node: TreeNode) => {
    node.isExpanded = true;
  }),
};

const queryStore = {
  createTab: vi.fn(),
  openNacosAdmin: vi.fn(),
};

vi.mock("@/stores/connectionStore", () => ({
  CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "connection attempt cancelled",
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => queryStore }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { sidebarActivation: "single" } }) }));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({}) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: vi.fn() }) }));
vi.mock("@/composables/useSidebarDataOpenRuntime", () => ({ useSidebarDataOpenRuntime: () => ({ openData: vi.fn() }) }));
vi.mock("@/composables/useDatabaseOptions", () => ({ useDatabaseOptions: () => ({ getDatabaseOptions: vi.fn() }) }));
vi.mock("@/composables/useSidebarConnectionMutationRuntime", () => ({ useSidebarConnectionMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarDatabaseSpecificMutationRuntime", () => ({ useSidebarDatabaseSpecificMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTableMutationRuntime", () => ({ useSidebarTableMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeExportRuntime", () => ({ useSidebarTreeExportRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeToolRuntime", () => ({ useSidebarTreeToolRuntime: () => ({}) }));

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  connectionStore.treeNodes = [];
  connectionStore.sidebarSearchQuery = "";
  vi.clearAllMocks();
  connectionStore.getConfig.mockReturnValue({ db_type: "mysql", name: "connection" });
});

describe("SidebarTreeRuntimeHost expansion", () => {
  it("publishes a rendered group collapse and synchronizes the live tree", async () => {
    const liveGroup: TreeNode = {
      id: "connection:database:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "connection",
      database: "database",
      isExpanded: true,
      children: [],
    };
    const renderedGroup: TreeNode = { ...liveGroup };
    connectionStore.treeNodes = [liveGroup];

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const toggled = vi.fn((node: TreeNode, expanded: boolean) => {
      syncSidebarTreeNodeExpansion(connectionStore.treeNodes, node, expanded);
    });
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: renderedGroup, depth: 0, onNodeToggled: toggled }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(renderedGroup);
    await nextTick();

    expect(toggled).toHaveBeenCalledWith(renderedGroup, false);
    expect(liveGroup.isExpanded).toBe(false);
  });

  it("loads Oracle package members through the shared expansion path", async () => {
    const packageNode: TreeNode = {
      id: "oracle:XE:APP:package:BUSINESS_API",
      label: "BUSINESS_API",
      type: "package",
      connectionId: "oracle",
      database: "XE",
      schema: "APP",
      isExpanded: false,
      children: [],
    };
    connectionStore.treeNodes = [packageNode];
    connectionStore.getConfig.mockReturnValue({ db_type: "oracle" });

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const toggled = vi.fn();
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: packageNode, depth: 0, onNodeToggled: toggled }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(packageNode);
    await vi.waitFor(() => expect(connectionStore.loadPackageMembers).toHaveBeenCalledWith(packageNode));

    expect(packageNode.isExpanded).toBe(true);
    expect(toggled).toHaveBeenCalledWith(packageNode, true);
  });

  it("keeps the latest Nacos navigation click when connection checks finish out of order", async () => {
    let resolveNamespaceConnection!: () => void;
    let resolveAccessControlConnection!: () => void;
    const namespaceConnection = new Promise<void>((resolve) => {
      resolveNamespaceConnection = resolve;
    });
    const accessControlConnection = new Promise<void>((resolve) => {
      resolveAccessControlConnection = resolve;
    });
    connectionStore.ensureConnected.mockImplementationOnce(() => namespaceConnection).mockImplementationOnce(() => accessControlConnection);
    connectionStore.getConfig.mockReturnValue({ db_type: "nacos", name: "local-nacos-v2" });

    const namespaceNode: TreeNode = {
      id: "nacos:nacos-namespace:public",
      label: "public",
      type: "nacos-namespace",
      connectionId: "nacos",
      nacosNamespace: "",
      nacosNamespaceName: "public",
    };
    const accessControlNode: TreeNode = {
      id: "nacos:nacos-access-control",
      label: "nacos.accessControlSidebarLabel",
      type: "nacos-access-control",
      connectionId: "nacos",
      // Persisted/reused tree state must not turn an application entry point
      // back into a generic expand/collapse action on the first click.
      isExpanded: true,
      children: [],
    };
    connectionStore.treeNodes = [namespaceNode, accessControlNode];

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: namespaceNode, depth: 0 }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    expect(host.value).not.toBeNull();
    host.value!.handleRowClick(namespaceNode, 1);
    host.value!.handleRowClick(accessControlNode, 1);

    await vi.waitFor(() => expect(connectionStore.ensureConnected).toHaveBeenCalledTimes(2));
    expect(connectionStore.ensureConnected).toHaveBeenNthCalledWith(1, "nacos", { verifyHealth: false });
    expect(connectionStore.ensureConnected).toHaveBeenNthCalledWith(2, "nacos", { verifyHealth: false });

    resolveAccessControlConnection();
    await vi.waitFor(() => expect(queryStore.createTab).toHaveBeenCalledWith("nacos", "", "local-nacos-v2:access-control", "nacos-access-control"));
    expect(accessControlNode.isExpanded).toBe(true);

    resolveNamespaceConnection();
    await namespaceConnection;
    await nextTick();

    expect(queryStore.openNacosAdmin).not.toHaveBeenCalled();
  });
});
