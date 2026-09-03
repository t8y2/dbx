// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, provide, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";
import { syncSidebarTreeNodeExpansion } from "@/lib/sidebar/sidebarTreeExpansion";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
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
  loadObjectGroupChildren: vi.fn(async (node: TreeNode) => {
    node.isExpanded = true;
  }),
  loadXuguTablespaces: vi.fn(async (node: TreeNode) => {
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
  connectionStore.canUseLoadedTreeNodeToggle.mockReturnValue(true);
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

  it("opens the Meilisearch system workspace from its direct-navigation node", async () => {
    connectionStore.getConfig.mockReturnValue({ db_type: "meilisearch", name: "local-meilisearch" });
    const systemNode: TreeNode = {
      id: "meili:meilisearch-system",
      label: "meilisearch.systemManagement",
      type: "meilisearch-system",
      connectionId: "meili",
      isExpanded: true,
      children: [],
    };
    connectionStore.treeNodes = [systemNode];

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: systemNode, depth: 0 }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    host.value!.handleRowClick(systemNode, 1);

    await vi.waitFor(() => expect(connectionStore.ensureConnected).toHaveBeenCalledWith("meili", undefined));
    expect(queryStore.createTab).toHaveBeenCalledWith("meili", "default", expect.any(String), "meilisearch-system");
    expect(systemNode.isExpanded).toBe(true);
  });

  it("expands an unloaded object group without leaking the regex source as a search filter", async () => {
    const group: TreeNode = {
      id: "mysql:basic:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "mysql",
      database: "basic",
      isExpanded: false,
      children: [],
    };
    // Regex mode keeps the store's remote-search state empty (ConnectionTree
    // writes resolveSidebarRemoteSearchQuery(...) into sidebarSearchQuery).
    connectionStore.sidebarSearchQuery = "";
    connectionStore.canUseLoadedTreeNodeToggle.mockReturnValue(false);

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, {
            getVisibleNodes: () => [group],
            getVisibleNodeIndex: () => 0,
            // ConnectionTree returns this explicit empty filter while regex
            // mode is on: expansion may connect, but never with the regex.
            getTreeLoadSearchOptions: () => ({ searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: "" }),
          });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: group, depth: 0 });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(group);

    await vi.waitFor(() =>
      expect(connectionStore.loadObjectGroupChildren).toHaveBeenCalledWith(group, {
        searchFilter: "",
        allowGlobalSearchMismatch: true,
        expectedSidebarSearchQuery: "",
      }),
    );
    // The regex source never reaches the store options or the connection layer.
    expect(JSON.stringify(connectionStore.loadObjectGroupChildren.mock.calls)).not.toContain("A|b");
  });

  it("preserves loaded group children while a local regex projection is active", async () => {
    const group: TreeNode = {
      id: "mysql:basic:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "mysql",
      database: "basic",
      isExpanded: true,
      children: [{ id: "mysql:basic:__tables:orders", label: "orders", type: "table", connectionId: "mysql", database: "basic" }],
    };
    connectionStore.sidebarSearchQuery = "";
    connectionStore.canUseLoadedTreeNodeToggle.mockReturnValue(true);

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, {
            getVisibleNodes: () => [group],
            getVisibleNodeIndex: () => 0,
            isSearchProjectionActive: () => true,
          });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: group, depth: 0 });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(group);
    await nextTick();

    expect(group.isExpanded).toBe(false);
    expect(connectionStore.releaseCollapsedTreeNodeChildren).not.toHaveBeenCalled();
  });

  it("expands an unloaded object group without leaking a matching connection name", async () => {
    const group: TreeNode = {
      id: "mysql:basic:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "mysql",
      database: "basic",
      isExpanded: false,
      children: [],
    };
    connectionStore.sidebarSearchQuery = "60307";
    connectionStore.canUseLoadedTreeNodeToggle.mockReturnValue(false);

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, {
            getVisibleNodes: () => [group],
            getVisibleNodeIndex: () => 0,
            getTreeLoadSearchOptions: () => ({ searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: "60307" }),
          });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: group, depth: 0 });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(group);

    await vi.waitFor(() =>
      expect(connectionStore.loadObjectGroupChildren).toHaveBeenCalledWith(group, {
        searchFilter: "",
        allowGlobalSearchMismatch: true,
        expectedSidebarSearchQuery: "60307",
      }),
    );
  });

  it("toggles Xugu package member groups locally instead of loading schema routines", async () => {
    const packageFunctionGroup: TreeNode = {
      id: "xugu:SHOP_DEMO:APP_TEST:package:PKG_CUSTOMER:members:functions",
      label: "tree.functions",
      type: "group-functions",
      parentType: "package",
      parentName: "PKG_CUSTOMER",
      parentSchema: "APP_TEST",
      connectionId: "xugu",
      database: "SHOP_DEMO",
      schema: "APP_TEST",
      objectCount: 401,
      isExpanded: false,
      children: Array.from({ length: 401 }, (_, index) => ({
        id: `xugu:SHOP_DEMO:APP_TEST:package:PKG_CUSTOMER:member:function:FUNC_${index}`,
        label: `FUNC_${index}()`,
        type: "function" as const,
        parentType: "package" as const,
        parentName: "PKG_CUSTOMER",
        parentSchema: "APP_TEST",
        connectionId: "xugu",
        database: "SHOP_DEMO",
        schema: "APP_TEST",
        objectName: `FUNC_${index}`,
        signature: "",
      })),
    };
    connectionStore.treeNodes = [packageFunctionGroup];
    connectionStore.getConfig.mockReturnValue({ db_type: "xugu" });
    connectionStore.canUseLoadedTreeNodeToggle.mockReturnValue(false);

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const toggled = vi.fn();
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: packageFunctionGroup, depth: 0, onNodeToggled: toggled }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(packageFunctionGroup);
    await nextTick();

    expect(packageFunctionGroup.isExpanded).toBe(true);
    expect(connectionStore.loadObjectGroupChildren).not.toHaveBeenCalled();
    expect(toggled).toHaveBeenCalledWith(packageFunctionGroup, true);

    host.value?.toggleNode(packageFunctionGroup);
    await nextTick();

    expect(packageFunctionGroup.isExpanded).toBe(false);
    expect(connectionStore.loadObjectGroupChildren).not.toHaveBeenCalled();

    expect(connectionStore.releaseCollapsedTreeNodeChildren).not.toHaveBeenCalled();
    expect(packageFunctionGroup.children).toHaveLength(401);

    host.value?.toggleNode(packageFunctionGroup);
    await nextTick();

    expect(packageFunctionGroup.isExpanded).toBe(true);
    expect(packageFunctionGroup.children).toHaveLength(401);
  });

  it("toggles Xugu tablespace and datafile group nodes locally", async () => {
    const datafileGroup: TreeNode = {
      id: "xugu:SHOP_DEMO:tablespace:SYSTEM:datafiles",
      label: "tree.datafiles",
      type: "group-datafiles",
      parentType: "tablespace",
      parentName: "SYSTEM",
      connectionId: "xugu",
      database: "SHOP_DEMO",
      objectCount: 2,
      isExpanded: false,
      children: [
        { id: "xugu:SHOP_DEMO:tablespace:SYSTEM:datafile:1", label: "system_01.dbf", type: "datafile", parentType: "tablespace", parentName: "SYSTEM", connectionId: "xugu", database: "SHOP_DEMO", objectName: "system_01.dbf" },
        { id: "xugu:SHOP_DEMO:tablespace:SYSTEM:datafile:2", label: "system_02.dbf", type: "datafile", parentType: "tablespace", parentName: "SYSTEM", connectionId: "xugu", database: "SHOP_DEMO", objectName: "system_02.dbf" },
      ],
    };
    const tablespaceNode: TreeNode = {
      id: "xugu:SHOP_DEMO:tablespace:SYSTEM",
      label: "SYSTEM",
      type: "tablespace",
      connectionId: "xugu",
      database: "SHOP_DEMO",
      objectName: "SYSTEM",
      isExpanded: false,
      children: [datafileGroup],
    };
    connectionStore.treeNodes = [tablespaceNode];
    connectionStore.getConfig.mockReturnValue({ db_type: "xugu" });
    connectionStore.canUseLoadedTreeNodeToggle.mockReturnValue(false);

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const toggled = vi.fn();
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: tablespaceNode, depth: 0, onNodeToggled: toggled }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(tablespaceNode);
    await nextTick();

    expect(tablespaceNode.isExpanded).toBe(true);
    expect(connectionStore.loadXuguTablespaces).not.toHaveBeenCalled();
    expect(toggled).toHaveBeenCalledWith(tablespaceNode, true);

    host.value?.toggleNode(datafileGroup);
    await nextTick();

    expect(datafileGroup.isExpanded).toBe(true);
    expect(connectionStore.loadXuguTablespaces).not.toHaveBeenCalled();
    expect(toggled).toHaveBeenCalledWith(datafileGroup, true);
  });
});
