// @vitest-environment happy-dom

import { computed, createApp, defineComponent, h, nextTick, provide, reactive, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";
import { syncSidebarTreeNodeExpansion } from "@/lib/sidebar/sidebarTreeExpansion";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import { OBJECT_BROWSER_SEARCH_FOCUS_EVENT } from "@/lib/tabs/objectBrowserSearchFocus";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";

const connectionStore = {
  treeNodes: [] as TreeNode[],
  selectedTreeNodeIds: [] as string[],
  sidebarSearchQuery: "",
  activeConnectionId: null as string | null,
  connectedIds: new Set<string>(),
  canUseLoadedTreeNodeToggle: vi.fn(() => true),
  releaseCollapsedTreeNodeChildren: vi.fn(),
  getConfig: vi.fn(() => ({ db_type: "mysql", name: "connection" })),
  getEtcdAccessCapabilities: vi.fn(() => ({ admin: true, writable: true, writePermissions: null })),
  ensureConnected: vi.fn(async () => undefined),
  loadPackageMembers: vi.fn(async (node: TreeNode) => {
    node.isExpanded = true;
  }),
  loadObjectGroupChildren: vi.fn(async (node: TreeNode) => {
    node.isExpanded = true;
  }),
  loadTables: vi.fn(async () => undefined),
  loadDatabases: vi.fn(async () => undefined),
  loadRedisDatabases: vi.fn(async () => undefined),
  loadMongoDatabases: vi.fn(async () => undefined),
  loadEtcdRoot: vi.fn(async () => undefined),
  loadMilvusDatabases: vi.fn(async () => undefined),
  loadElasticsearchIndices: vi.fn(async () => undefined),
  loadCustomTypeChildren: vi.fn(async (node: TreeNode) => {
    node.hasMembers = true;
    node.children = [{ id: `${node.id}:attribute`, label: "STREET", type: "type-member", connectionId: node.connectionId, database: node.database }];
    node.isExpanded = true;
  }),
  loadXuguTablespaces: vi.fn(async (node: TreeNode) => {
    node.isExpanded = true;
  }),
};

const queryStore = {
  tabs: [] as Array<{ id: string; mode: string; connectionId: string; database: string; title?: string; tableMeta?: { tableName: string } }>,
  createTab: vi.fn(),
  switchTab: vi.fn(),
  updateSql: vi.fn(),
  setTableMeta: vi.fn(),
  openNacosAdmin: vi.fn(),
  openDamengJobAdmin: vi.fn(),
  openDatabaseJobAdmin: vi.fn(),
  openObjectBrowser: vi.fn(() => "object-browser-tab"),
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
const compiledSearchHandlers = compileConnectionTreeTestScript(["onSearchToggle", "onNodeToggled"]);

function searchHandlers(searchCollapsedIds: { value: Set<string> }) {
  const bindings = { searchCollapsedIds, isTreeSearchFiltering: ref(true), store: connectionStore, syncSidebarTreeNodeExpansion, sidebarLayoutMonitor: { recordEvent: vi.fn() } };
  return new Function(...Object.keys(bindings), `${compiledSearchHandlers}; return { onSearchToggle, onNodeToggled };`)(...Object.values(bindings)) as {
    onSearchToggle: (node: TreeNode) => void;
    onNodeToggled: (node: TreeNode, expanded: boolean) => void;
  };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  connectionStore.treeNodes = [];
  connectionStore.sidebarSearchQuery = "";
  connectionStore.activeConnectionId = null;
  connectionStore.connectedIds.clear();
  queryStore.tabs = [];
  settingsStore.editorSettings.sidebarActivation = "single";
  settingsStore.editorSettings.sidebarBrowseObjectsOnDatabaseActivation = false;
  vi.clearAllMocks();
  connectionStore.canUseLoadedTreeNodeToggle.mockReturnValue(true);
  connectionStore.getConfig.mockReturnValue({ db_type: "mysql", name: "connection" });
  connectionStore.getEtcdAccessCapabilities.mockReturnValue({ admin: true, writable: true, writePermissions: null });
  connectionStore.loadTables.mockResolvedValue(undefined);
  connectionStore.loadCustomTypeChildren.mockClear();
});

describe("SidebarTreeRuntimeHost expansion", () => {
  it.each(["dameng-job-admin", "database-job-admin"] as const)("opens %s through the direct-navigation production path", async (type) => {
    const node: TreeNode = { id: `c:${type}`, label: "Jobs", type, connectionId: "c", database: "" };
    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);
    host.value?.handleRowClick(node, 1);
    host.value?.handleRowClick(node, 2);
    host.value?.handleRowDoubleClick(node, new MouseEvent("dblclick"));
    const open = type === "dameng-job-admin" ? queryStore.openDamengJobAdmin : queryStore.openDatabaseJobAdmin;
    await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("c"));
    expect(connectionStore.loadObjectGroupChildren).not.toHaveBeenCalled();
    expect(node.children).toBeUndefined();
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("lazy-loads unknown TYPE members for %s on row activation", async (dbType) => {
    const typeNode: TreeNode = { id: `${dbType}:demo:APP:TYPE_OBJ`, label: "TYPE_OBJ", type: "type", connectionId: dbType, database: "demo", schema: "APP", objectName: "TYPE_OBJ", hasMembers: undefined };
    connectionStore.getConfig.mockReturnValue({ db_type: dbType });
    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: typeNode, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);
    host.value!.handleRowClick(typeNode, 1);
    await vi.waitFor(() => expect(connectionStore.loadCustomTypeChildren).toHaveBeenCalledWith(typeNode));
    expect(typeNode.children?.[0]?.label).toBe("STREET");
    expect(queryStore.createTab).not.toHaveBeenCalled();
  });

  it("retries expansion for Oracle TYPE nodes with partial children and unknown member state", async () => {
    const typeNode: TreeNode = {
      id: "oracle:XE:APP:TYPE_OBJ",
      label: "TYPE_OBJ",
      type: "type",
      connectionId: "oracle",
      database: "XE",
      schema: "APP",
      hasMembers: undefined,
      children: [{ id: "oracle:XE:APP:TYPE_OBJ:attribute", label: "STREET", type: "type-member", connectionId: "oracle", database: "XE" }],
    };
    connectionStore.getConfig.mockReturnValue({ db_type: "oracle" });
    connectionStore.loadCustomTypeChildren.mockImplementation(async (node: TreeNode) => {
      node.hasMembers = undefined;
      node.children = [{ id: `${node.id}:attribute`, label: "STREET", type: "type-member", connectionId: node.connectionId, database: node.database }];
      node.isExpanded = true;
    });
    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: typeNode, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value!.toggleNode(typeNode);
    await vi.waitFor(() => expect(connectionStore.loadCustomTypeChildren).toHaveBeenCalledTimes(1));
    expect(typeNode.isExpanded).toBe(true);
    expect(typeNode.children?.map((child) => child.label)).toEqual(["STREET"]);
    host.value!.toggleNode(typeNode);
    expect(typeNode.isExpanded).toBe(false);
    host.value!.toggleNode(typeNode);
    await vi.waitFor(() => expect(connectionStore.loadCustomTypeChildren).toHaveBeenCalledTimes(2));
    expect(typeNode.isExpanded).toBe(true);
  });

  it.each(["single", "double"] as const)("focuses object search when %s-click activation opens a database", async (activation) => {
    const database: TreeNode = {
      id: "mysql:dbx_test",
      label: "dbx_test",
      type: "database",
      connectionId: "mysql",
      database: "dbx_test",
      isExpanded: true,
      children: [],
    };
    settingsStore.editorSettings.sidebarActivation = activation;
    settingsStore.editorSettings.sidebarBrowseObjectsOnDatabaseActivation = true;
    const focusRequested = vi.fn();
    window.addEventListener(OBJECT_BROWSER_SEARCH_FOCUS_EVENT, focusRequested);

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: database, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    if (activation === "single") {
      host.value?.handleRowClick(database, 1);
    } else {
      host.value?.handleRowDoubleClick(database, new MouseEvent("dblclick"));
    }

    await vi.waitFor(() => expect(queryStore.openObjectBrowser).toHaveBeenCalledWith("mysql", "dbx_test", undefined, undefined, undefined, false, undefined, undefined));
    await vi.waitFor(() => expect(focusRequested).toHaveBeenCalledOnce());
    expect((focusRequested.mock.calls[0]?.[0] as CustomEvent<{ tabId: string }>).detail.tabId).toBe("object-browser-tab");

    window.removeEventListener(OBJECT_BROWSER_SEARCH_FOCUS_EVENT, focusRequested);
  });

  it("toggles an expanded database closed on double-click in double-click activation mode", async () => {
    const database: TreeNode = {
      id: "mysql:dbx_test",
      label: "dbx_test",
      type: "database",
      connectionId: "mysql",
      database: "dbx_test",
      isExpanded: true,
      children: [],
    };
    settingsStore.editorSettings.sidebarActivation = "double";
    settingsStore.editorSettings.sidebarBrowseObjectsOnDatabaseActivation = true;

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: database, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.handleRowDoubleClick(database, new MouseEvent("dblclick"));
    await nextTick();

    expect(database.isExpanded).toBe(false);
  });

  it("does not collapse an expanded database on click in single-click activation mode", async () => {
    const database: TreeNode = {
      id: "mysql:dbx_test",
      label: "dbx_test",
      type: "database",
      connectionId: "mysql",
      database: "dbx_test",
      isExpanded: true,
      children: [],
    };
    settingsStore.editorSettings.sidebarActivation = "single";
    settingsStore.editorSettings.sidebarBrowseObjectsOnDatabaseActivation = true;

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: database, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.handleRowClick(database, 1);
    await nextTick();

    expect(database.isExpanded).toBe(true);
  });

  it("reuses a Mongo collection tab by identity without replacing its state", async () => {
    const collection: TreeNode = {
      id: "mongo:app:orders",
      label: "orders",
      type: "mongo-collection",
      connectionId: "mongo",
      database: "app",
    };
    connectionStore.getConfig.mockReturnValue({ db_type: "mongodb", name: "connection" });
    queryStore.tabs = [
      { id: "other-database", mode: "mongo", connectionId: "mongo", database: "other", tableMeta: { tableName: "orders" } },
      { id: "orders-tab", mode: "mongo", connectionId: "mongo", database: "app", title: "My renamed collection", tableMeta: { tableName: "orders" } },
    ];
    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: collection, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.handleRowClick(collection, 1);
    await nextTick();

    expect(queryStore.switchTab).toHaveBeenCalledWith("orders-tab");
    expect(queryStore.createTab).not.toHaveBeenCalled();
    expect(queryStore.updateSql).not.toHaveBeenCalled();
    expect(queryStore.setTableMeta).not.toHaveBeenCalled();
  });

  it.each([false, true])("opens the context-menu Mongo collection without changing expansion (%s)", async (isExpanded) => {
    const collection: TreeNode = { id: "mongo:app:orders", label: "orders", type: "mongo-collection", connectionId: "mongo", database: "app", isExpanded, children: [] };
    const otherCollection: TreeNode = { ...collection, id: "mongo:app:customers", label: "customers" };
    connectionStore.getConfig.mockReturnValue({ db_type: "mongodb", name: "connection" });
    queryStore.tabs = [
      { id: "other-database", mode: "mongo", connectionId: "mongo", database: "other", tableMeta: { tableName: "orders" } },
      { id: "other-connection", mode: "mongo", connectionId: "another-mongo", database: "app", tableMeta: { tableName: "orders" } },
    ];
    queryStore.createTab.mockReturnValueOnce("orders-tab");
    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: otherCollection, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    const action = host.value!.buildContextMenu(collection).find((item) => item.label === i18n.global.t("contextMenu.viewData"))?.action;
    expect(action).toBeTypeOf("function");
    await action!();

    expect(queryStore.createTab).toHaveBeenCalledExactlyOnceWith("mongo", "app", "app.orders", "mongo");
    expect(queryStore.updateSql).toHaveBeenCalledWith("orders-tab", "orders");
    expect(queryStore.setTableMeta).toHaveBeenCalledWith("orders-tab", expect.objectContaining({ database: "app", tableName: "orders" }));
    expect(queryStore.switchTab).not.toHaveBeenCalled();
    expect(collection.isExpanded).toBe(isExpanded);

    // Represent the created tab, including a user-renamed title, on the next invocation.
    queryStore.tabs.push({ id: "orders-tab", mode: "mongo", connectionId: "mongo", database: "app", title: "My renamed collection", tableMeta: { tableName: "orders" } });
    queryStore.updateSql.mockClear();
    queryStore.setTableMeta.mockClear();
    await action!();

    expect(queryStore.switchTab).toHaveBeenCalledExactlyOnceWith("orders-tab");
    expect(queryStore.createTab).toHaveBeenCalledOnce();
    expect(queryStore.updateSql).not.toHaveBeenCalled();
    expect(queryStore.setTableMeta).not.toHaveBeenCalled();
    expect(collection.isExpanded).toBe(isExpanded);
  });

  it("keeps a searched database browse-and-expand activation current through the complete double-click sequence", async () => {
    let resolveConnection!: () => void;
    const connection = new Promise<void>((resolve) => {
      resolveConnection = resolve;
    });
    connectionStore.ensureConnected.mockReturnValue(connection);
    settingsStore.editorSettings.sidebarBrowseObjectsOnDatabaseActivation = true;

    const database: TreeNode = {
      id: "mysql:inventory",
      label: "inventory",
      type: "database",
      connectionId: "mysql",
      database: "inventory",
      isExpanded: false,
      children: [],
    };
    const root: TreeNode = {
      id: "mysql",
      label: "local-mysql",
      type: "connection",
      connectionId: "mysql",
      isExpanded: true,
      children: [database],
    };
    connectionStore.treeNodes = [root];
    const searchedDatabase = filterSidebarTree([root], "inventory", new Set())[0]?.children?.[0];
    expect(searchedDatabase).toBeDefined();
    expect(searchedDatabase).not.toBe(database);

    const cancellationHandled = vi.fn();
    const cancellation = {
      get message() {
        cancellationHandled();
        return "Connection attempt was cancelled";
      },
    };
    connectionStore.loadTables.mockImplementationOnce(async () => {
      await connectionStore.ensureConnected("mysql");
      throw cancellation;
    });

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: searchedDatabase!, depth: 1 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    // A browser double click emits click(1), click(2), then dblclick. Only the
    // first event activates a database in single-click mode.
    host.value!.handleRowClick(searchedDatabase!, 1);
    await vi.waitFor(() => expect(connectionStore.ensureConnected).toHaveBeenCalledOnce());
    host.value!.handleRowClick(searchedDatabase!, 2);
    host.value!.handleRowDoubleClick(searchedDatabase!, new MouseEvent("dblclick", { detail: 2 }));

    expect(connectionStore.loadTables).toHaveBeenCalledOnce();
    expect(connectionStore.ensureConnected).toHaveBeenCalledTimes(2);

    resolveConnection();
    // Reading the cancellation proves the original request still owns its
    // completion; a stale request returns before classifying the failure.
    await vi.waitFor(() => expect(cancellationHandled).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(queryStore.openObjectBrowser).toHaveBeenCalledOnce());
    expect(queryStore.openObjectBrowser).toHaveBeenCalledWith("mysql", "inventory", undefined, undefined, undefined, false, undefined, undefined);
    expect(toast).not.toHaveBeenCalled();
  });

  it("activates the owning connection when a cached node toggles locally", async () => {
    const group: TreeNode = {
      id: "mysql:basic:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "mysql",
      database: "basic",
      isExpanded: false,
      children: [{ id: "mysql:basic:orders", label: "orders", type: "table", connectionId: "mysql", database: "basic" }],
    };
    connectionStore.connectedIds.add("mysql");
    connectionStore.activeConnectionId = "another-connection";

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: group, depth: 0 }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(group);
    await nextTick();

    expect(connectionStore.activeConnectionId).toBe("mysql");
    expect(group.isExpanded).toBe(true);
    expect(connectionStore.loadObjectGroupChildren).not.toHaveBeenCalled();
  });

  it("routes an opted-in partial table group back through the loader", async () => {
    const group: TreeNode = {
      id: "mysql:basic:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "mysql",
      database: "basic",
      isExpanded: false,
      children: [
        { id: "mysql:basic:orders", label: "orders", type: "table", connectionId: "mysql", database: "basic" },
        {
          id: "mysql:basic:__tables:__load_more:1000",
          label: "tree.loadMore",
          type: "load-more",
          connectionId: "mysql",
          database: "basic",
          loadMore: { parentId: "mysql:basic:__tables", offset: 1000, pageSize: 1000 },
        },
      ],
    };
    connectionStore.getConfig.mockReturnValue({ db_type: "mysql", name: "connection", sidebar_auto_load_all_tables: true });

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: group, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(group);

    await vi.waitFor(() => expect(connectionStore.loadObjectGroupChildren).toHaveBeenCalledWith(group, undefined));
    expect(group.isExpanded).toBe(true);
  });

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

  it("opens etcd workspaces without waiting for a connection health probe", async () => {
    connectionStore.getConfig.mockReturnValue({ db_type: "etcd", name: "local-etcd-v3" });
    connectionStore.ensureConnected.mockImplementation(async (...args: any[]) => {
      const options = args[1] as { verifyHealth?: boolean } | undefined;
      if (options?.verifyHealth === false) return;
      await new Promise<void>(() => undefined);
    });
    const nodes: TreeNode[] = [
      { id: "etcd:root", label: "Keys", type: "etcd-root", connectionId: "etcd" },
      { id: "etcd:access-control", label: "Users & Roles", type: "etcd-access-control", connectionId: "etcd" },
      { id: "etcd:dashboard", label: "Dashboard", type: "etcd-dashboard", connectionId: "etcd" },
    ];
    connectionStore.treeNodes = nodes;

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: nodes[0], depth: 0 }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    for (const [index, node] of nodes.entries()) {
      host.value!.handleRowClick(node, index + 1);
      await vi.waitFor(() => expect(queryStore.createTab).toHaveBeenCalledTimes(index + 1));
    }

    expect(connectionStore.ensureConnected).toHaveBeenNthCalledWith(1, "etcd", { verifyHealth: false });
    expect(connectionStore.ensureConnected).toHaveBeenNthCalledWith(2, "etcd", { verifyHealth: false });
    expect(connectionStore.ensureConnected).toHaveBeenNthCalledWith(3, "etcd", { verifyHealth: false });
    expect(queryStore.createTab).toHaveBeenNthCalledWith(1, "etcd", "", "local-etcd-v3:keys", "etcd");
    expect(queryStore.createTab).toHaveBeenNthCalledWith(2, "etcd", "", "local-etcd-v3:access-control", "etcd-access-control");
    expect(queryStore.createTab).toHaveBeenNthCalledWith(3, "etcd", "", "local-etcd-v3:dashboard", "etcd-dashboard");
  });

  it("does not let the trailing dblclick cancel a pending etcd navigation", async () => {
    let resolveConnection!: () => void;
    const connection = new Promise<void>((resolve) => {
      resolveConnection = resolve;
    });
    connectionStore.ensureConnected.mockReturnValue(connection);
    connectionStore.getConfig.mockReturnValue({ db_type: "etcd", name: "local-etcd-v3" });
    const node: TreeNode = { id: "etcd:dashboard", label: "Dashboard", type: "etcd-dashboard", connectionId: "etcd" };
    connectionStore.treeNodes = [node];

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node, depth: 0 }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    host.value!.handleRowClick(node, 1);
    host.value!.handleRowDoubleClick(node, new MouseEvent("dblclick", { detail: 2 }));
    resolveConnection();

    await vi.waitFor(() => expect(queryStore.createTab).toHaveBeenCalledWith("etcd", "", "local-etcd-v3:dashboard", "etcd-dashboard"));
  });

  it("does not reopen a stale etcd admin node after access becomes restricted", async () => {
    connectionStore.getConfig.mockReturnValue({ db_type: "etcd", name: "local-etcd-v3" });
    connectionStore.getEtcdAccessCapabilities.mockReturnValue({ admin: false, writable: true, writePermissions: [] });
    const node: TreeNode = { id: "etcd:dashboard", label: "Dashboard", type: "etcd-dashboard", connectionId: "etcd" };
    connectionStore.treeNodes = [node];

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node, depth: 0 }) }));
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    host.value!.handleRowClick(node, 1);
    await vi.waitFor(() => expect(connectionStore.ensureConnected).toHaveBeenCalled());
    expect(queryStore.createTab).not.toHaveBeenCalled();
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

  it("expands a collapsed search projection without reloading its live subtree", async () => {
    const tableGroup: TreeNode = {
      id: "mysql:basic:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "mysql",
      database: "basic",
      isExpanded: true,
      children: [{ id: "mysql:basic:__tables:json_orders", label: "json_orders", type: "table", connectionId: "mysql", database: "basic" }],
    };
    const database: TreeNode = {
      id: "mysql:basic",
      label: "basic",
      type: "database",
      connectionId: "mysql",
      database: "basic",
      isExpanded: false,
      children: [tableGroup],
    };
    connectionStore.sidebarSearchQuery = "json";
    const collapsedIds = ref(new Set([database.id]));
    const projection = computed(() => filterSidebarTree([database], "json", collapsedIds.value));
    const handlers = searchHandlers(collapsedIds);
    const searchToggle = vi.fn(handlers.onSearchToggle);
    const nodeToggled = vi.fn(handlers.onNodeToggled);

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, {
            getVisibleNodes: () => projection.value,
            getVisibleNodeIndex: () => 0,
            isSearchProjectionActive: () => true,
          });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: database, depth: 0, onSearchToggle: searchToggle, onNodeToggled: nodeToggled });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(database);
    await nextTick();

    expect(searchToggle).toHaveBeenCalledWith(database);
    expect(projection.value[0].isExpanded).toBe(true);
    expect(database.isExpanded).toBe(false);
    expect(nodeToggled).not.toHaveBeenCalled();
    expect(connectionStore.loadTables).not.toHaveBeenCalled();
    expect(connectionStore.releaseCollapsedTreeNodeChildren).not.toHaveBeenCalled();
  });

  it.each([
    { loaded: false, query: "north" },
    { loaded: true, query: "north" },
    { loaded: false, query: "basic" },
  ])("expands a database during search ($query, loaded: $loaded)", async ({ loaded, query }) => {
    const tableGroup: TreeNode = {
      id: "mysql:basic:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "mysql",
      database: "basic",
      isExpanded: false,
      children: [
        { id: "mysql:basic:orders", label: "orders", type: "table", connectionId: "mysql", database: "basic" },
        { id: "mysql:basic:customers", label: "customers", type: "table", connectionId: "mysql", database: "basic" },
      ],
    };
    const database = reactive<TreeNode>({
      id: "mysql:basic",
      label: "basic",
      type: "database",
      connectionId: "mysql",
      database: "basic",
      isExpanded: false,
      // Unopened databases can already contain their saved-SQL shortcut.
      children: loaded ? [tableGroup] : [{ id: "mysql:basic:queries", label: "tree.queries", type: "saved-sql-root", connectionId: "mysql", database: "basic", children: [] }],
    });
    const otherDatabase: TreeNode = { id: "mysql:other", label: "other", type: "database", connectionId: "mysql", database: "other", isExpanded: false, children: [] };
    const root: TreeNode = { id: "mysql", label: "north", type: "connection", connectionId: "mysql", isExpanded: true, children: [database, otherDatabase] };
    connectionStore.treeNodes = [root];
    connectionStore.connectedIds.add("mysql");
    connectionStore.loadTables.mockImplementation(async () => {
      if (!loaded) database.children = [tableGroup];
      database.isExpanded = true;
    });
    const collapsedIds = ref(new Set(query === "basic" ? [database.id] : []));
    const projectedDatabase = computed(() => filterSidebarTree([root], query, collapsedIds.value)[0].children![0]);
    const handlers = searchHandlers(collapsedIds);
    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, {
            getVisibleNodes: () => [projectedDatabase.value],
            getVisibleNodeIndex: () => 0,
            isSearchProjectionActive: () => true,
            getTreeLoadSearchOptions: () => ({ searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: "" }),
          });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: projectedDatabase.value, depth: 1, onSearchToggle: handlers.onSearchToggle, onNodeToggled: handlers.onNodeToggled });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value!.toggleNode(projectedDatabase.value);
    await vi.waitFor(() => expect(projectedDatabase.value.isExpanded).toBe(true));
    expect(connectionStore.loadTables).toHaveBeenCalledExactlyOnceWith("mysql", "basic", undefined, { searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: "" });
    expect(database.children?.[0].children?.map((node) => node.label)).toEqual(["orders", "customers"]);
    expect(otherDatabase.isExpanded).toBe(false);

    host.value!.toggleNode(projectedDatabase.value);
    await nextTick();
    expect(projectedDatabase.value.isExpanded).toBe(false);
    host.value!.toggleNode(projectedDatabase.value);
    await vi.waitFor(() => expect(projectedDatabase.value.isExpanded).toBe(true));
    expect(connectionStore.loadTables).toHaveBeenCalledTimes(query === "basic" ? 1 : 2);
    expect(connectionStore.releaseCollapsedTreeNodeChildren).not.toHaveBeenCalled();
  });

  it("reopens a cached table group below a matching connection without replacing its children", async () => {
    const group = reactive<TreeNode>({
      id: "mysql:basic:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "mysql",
      database: "basic",
      isExpanded: true,
      children: [
        { id: "mysql:basic:orders", label: "orders", type: "table", connectionId: "mysql", database: "basic" },
        { id: "mysql:basic:customers", label: "customers", type: "table", connectionId: "mysql", database: "basic" },
      ],
    });
    const root: TreeNode = { id: "mysql", label: "north", type: "connection", connectionId: "mysql", isExpanded: true, children: [{ id: "mysql:basic", label: "basic", type: "database", connectionId: "mysql", database: "basic", isExpanded: true, children: [group] }] };
    connectionStore.treeNodes = [root];
    connectionStore.connectedIds.add("mysql");
    const collapsedIds = ref(new Set<string>());
    const projectedGroup = computed(() => filterSidebarTree([root], "north", collapsedIds.value)[0].children![0].children![0]);
    const handlers = searchHandlers(collapsedIds);
    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, { getVisibleNodes: () => [projectedGroup.value], getVisibleNodeIndex: () => 0, isSearchProjectionActive: () => true });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: projectedGroup.value, depth: 2, onSearchToggle: handlers.onSearchToggle, onNodeToggled: handlers.onNodeToggled });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);
    const children = group.children;

    for (let cycle = 0; cycle < 2; cycle++) {
      host.value!.toggleNode(projectedGroup.value);
      await nextTick();
      expect(projectedGroup.value.isExpanded).toBe(false);
      expect(collapsedIds.value.has("mysql:basic:orders")).toBe(true);
      host.value!.toggleNode(projectedGroup.value);
      await nextTick();
      expect(projectedGroup.value.isExpanded).toBe(true);
      expect(group.isExpanded).toBe(true);
      expect(group.children).toBe(children);
    }
    expect(connectionStore.loadObjectGroupChildren).not.toHaveBeenCalled();
    expect(connectionStore.releaseCollapsedTreeNodeChildren).not.toHaveBeenCalled();
  });

  it("does not skip schema expansion when another visible database has the same node id", async () => {
    const schema = reactive<TreeNode>({ id: "pg:a:b", label: "b", type: "schema", connectionId: "pg", database: "a", schema: "b", isExpanded: false, children: [{ id: "pg:a:b:tables", label: "Tables", type: "group-tables", connectionId: "pg", database: "a", schema: "b", children: [] }] });
    const otherDatabase: TreeNode = { id: "pg:a:b", label: "a:b", type: "database", connectionId: "pg", database: "a:b", isExpanded: true, children: [] };
    const root: TreeNode = { id: "pg", label: "north", type: "connection", connectionId: "pg", isExpanded: true, children: [{ id: "pg:a", label: "a", type: "database", connectionId: "pg", database: "a", isExpanded: true, children: [schema] }, otherDatabase] };
    connectionStore.treeNodes = [root];
    connectionStore.connectedIds.add("pg");
    connectionStore.getConfig.mockReturnValue({ db_type: "postgres", name: "north" });
    connectionStore.loadTables.mockImplementation(async () => {
      schema.isExpanded = true;
    });
    const collapsedIds = ref(new Set<string>());
    const projection = computed(() => filterSidebarTree([root], "north", collapsedIds.value)[0]);
    const visible = computed(() => [projection.value.children![0].children![0], projection.value.children![1]]);
    const handlers = searchHandlers(collapsedIds);
    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, { getVisibleNodes: () => visible.value, getVisibleNodeIndex: () => 1, isSearchProjectionActive: () => true });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: visible.value[0], depth: 2, onSearchToggle: handlers.onSearchToggle, onNodeToggled: handlers.onNodeToggled });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value!.toggleNode(visible.value[0]);
    await vi.waitFor(() => expect(schema.isExpanded).toBe(true));
    expect(connectionStore.loadTables).toHaveBeenCalledExactlyOnceWith("pg", "a", "b", undefined);
    expect(otherDatabase.isExpanded).toBe(true);
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

  it("collapses all child and descendant nodes when a parent node is collapsed", async () => {
    const columnsGroup: TreeNode = {
      id: "mysql:db:table:users:group-columns",
      label: "Columns",
      type: "group-columns",
      connectionId: "mysql",
      database: "db",
      tableName: "users",
      isExpanded: true,
      children: [{ id: "mysql:db:table:users:col:id", label: "id", type: "column", connectionId: "mysql", database: "db", tableName: "users" }],
    };
    const tableNode: TreeNode = {
      id: "mysql:db:table:users",
      label: "users",
      type: "table",
      connectionId: "mysql",
      database: "db",
      isExpanded: true,
      children: [columnsGroup],
    };
    const tablesGroup: TreeNode = {
      id: "mysql:db:group-tables",
      label: "Tables",
      type: "group-tables",
      connectionId: "mysql",
      database: "db",
      isExpanded: true,
      children: [tableNode],
    };
    const databaseNode: TreeNode = {
      id: "mysql:db",
      label: "db",
      type: "database",
      connectionId: "mysql",
      database: "db",
      isExpanded: true,
      children: [tablesGroup],
    };

    connectionStore.treeNodes = [databaseNode];
    connectionStore.loadTables.mockImplementation(async () => {
      databaseNode.isExpanded = true;
    });
    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const toggled = vi.fn((node: TreeNode, expanded: boolean) => {
      syncSidebarTreeNodeExpansion(connectionStore.treeNodes, node, expanded);
    });
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: databaseNode, depth: 0, onNodeToggled: toggled }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    // Collapsing databaseNode
    host.value?.toggleNode(databaseNode);
    await nextTick();

    expect(databaseNode.isExpanded).toBe(false);
    expect(tablesGroup.isExpanded).toBe(false);
    expect(tableNode.isExpanded).toBe(false);
    expect(columnsGroup.isExpanded).toBe(false);
    expect(toggled).toHaveBeenCalledWith(databaseNode, false);

    // Re-expanding databaseNode
    host.value?.toggleNode(databaseNode);
    await nextTick();

    expect(databaseNode.isExpanded).toBe(true);
    // Descendants must remain collapsed after parent is re-expanded
    expect(tablesGroup.isExpanded).toBe(false);
    expect(tableNode.isExpanded).toBe(false);
    expect(columnsGroup.isExpanded).toBe(false);
  });

  it("collapses all child connections and their descendants when a connection-group collapses", async () => {
    const databaseNode: TreeNode = {
      id: "mysql:db",
      label: "db",
      type: "database",
      connectionId: "mysql",
      database: "db",
      isExpanded: true,
      children: [],
    };
    const connectionNode: TreeNode = {
      id: "mysql",
      label: "MySQL",
      type: "connection",
      connectionId: "mysql",
      isExpanded: true,
      children: [databaseNode],
    };
    const groupNode: TreeNode = {
      id: "group-1",
      label: "Dev Group",
      type: "connection-group",
      isExpanded: true,
      children: [connectionNode],
    };

    connectionStore.treeNodes = [groupNode];
    connectionStore.toggleConnectionGroupCollapsed = vi.fn();

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const toggled = vi.fn((node: TreeNode, expanded: boolean) => {
      syncSidebarTreeNodeExpansion(connectionStore.treeNodes, node, expanded);
    });
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: groupNode, depth: 0, onNodeToggled: toggled }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(groupNode);
    await nextTick();

    expect(groupNode.isExpanded).toBe(false);
    expect(connectionNode.isExpanded).toBe(false);
    expect(databaseNode.isExpanded).toBe(false);
  });

  it("expands a connection on first click even when loader does not pre-set isExpanded (issue #13536)", async () => {
    const databaseNode: TreeNode = {
      id: "mysql:db1",
      label: "db1",
      type: "database",
      connectionId: "mysql",
      database: "db1",
      isExpanded: false,
      children: [],
    };
    const connectionNode = reactive<TreeNode>({
      id: "mysql",
      label: "MySQL Prod",
      type: "connection",
      connectionId: "mysql",
      isExpanded: false,
      children: [],
    });

    connectionStore.treeNodes = [connectionNode];
    connectionStore.loadDatabases = vi.fn(async () => {
      // Loader attaches children but does not set isExpanded (e.g. sidebarExpandTreeOnConnect is false)
      connectionNode.children = [databaseNode];
    });

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const toggled = vi.fn((node: TreeNode, expanded: boolean) => {
      syncSidebarTreeNodeExpansion(connectionStore.treeNodes, node, expanded);
    });
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: connectionNode, depth: 0, onNodeToggled: toggled }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(connectionNode);
    await vi.waitFor(() => expect(connectionNode.isExpanded).toBe(true));

    expect(connectionStore.loadDatabases).toHaveBeenCalledWith("mysql", undefined);
    expect(connectionStore.treeNodes[0].isExpanded).toBe(true);
    expect(toggled).toHaveBeenCalledWith(connectionNode, true);
  });

  it("expands a connection during search on first click (issue #13536)", async () => {
    const databaseNode: TreeNode = {
      id: "mysql:db1",
      label: "db1",
      type: "database",
      connectionId: "mysql",
      database: "db1",
      isExpanded: false,
      children: [],
    };
    const connectionNode = reactive<TreeNode>({
      id: "mysql",
      label: "MySQL Prod",
      type: "connection",
      connectionId: "mysql",
      isExpanded: false,
      children: [],
    });

    connectionStore.treeNodes = [connectionNode];
    connectionStore.loadDatabases = vi.fn(async () => {
      connectionNode.children = [databaseNode];
    });

    const collapsedIds = ref(new Set<string>());
    const projection = computed(() => filterSidebarTree(connectionStore.treeNodes, "MySQL", collapsedIds.value));
    const handlers = searchHandlers(collapsedIds);

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, {
            getVisibleNodes: () => projection.value,
            getVisibleNodeIndex: () => 0,
            isSearchProjectionActive: () => true,
            getTreeLoadSearchOptions: () => ({ searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: "" }),
          });
          return () =>
            h(SidebarTreeRuntimeHost, {
              ref: host,
              node: projection.value[0],
              depth: 0,
              onSearchToggle: handlers.onSearchToggle,
              onNodeToggled: handlers.onNodeToggled,
            });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(projection.value[0]);
    await vi.waitFor(() => expect(projection.value[0].isExpanded).toBe(true));

    expect(connectionStore.loadDatabases).toHaveBeenCalledWith("mysql", {
      searchFilter: "",
      allowGlobalSearchMismatch: true,
      expectedSidebarSearchQuery: "",
    });
    expect(connectionStore.treeNodes[0].isExpanded).toBe(true);
    expect(projection.value[0].isExpanded).toBe(true);
    expect(projection.value[0].children?.map((c) => c.label)).toEqual(["db1"]);
  });

  // #13579: the manual-expansion regression hit every connection type, not just
  // SQL engines. Each loader below attaches children without setting
  // isExpanded (sidebarExpandTreeOnConnect defaults to false), so the shared
  // toggle path must expand the connection node itself.
  it.each([
    { dbType: "redis", loader: "loadRedisDatabases" as const, childType: "redis-db" as const },
    { dbType: "mongodb", loader: "loadMongoDatabases" as const, childType: "mongo-db" as const },
    { dbType: "etcd", loader: "loadEtcdRoot" as const, childType: "etcd-root" as const },
    { dbType: "milvus", loader: "loadMilvusDatabases" as const, childType: "vector-database" as const },
    { dbType: "elasticsearch", loader: "loadElasticsearchIndices" as const, childType: "elasticsearch-index" as const },
  ])("expands a $dbType connection on first click (issue #13579)", async ({ dbType, loader, childType }) => {
    const connectionId = `${dbType}-conn`;
    const child: TreeNode = {
      id: `${connectionId}:child`,
      label: `${dbType} child`,
      type: childType,
      connectionId,
      isExpanded: false,
      children: [],
    };
    const connectionNode = reactive<TreeNode>({
      id: connectionId,
      label: `${dbType} connection`,
      type: "connection",
      connectionId,
      isExpanded: false,
      children: [],
    });

    connectionStore.getConfig.mockReturnValue({ db_type: dbType, name: dbType } as ReturnType<typeof connectionStore.getConfig>);
    connectionStore.treeNodes = [connectionNode];
    const loaderMock = connectionStore[loader] as ReturnType<typeof vi.fn>;
    loaderMock.mockImplementation(async () => {
      connectionNode.children = [child];
    });

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: connectionNode, depth: 0 }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(connectionNode);
    await vi.waitFor(() => expect(connectionNode.isExpanded).toBe(true));

    expect(loaderMock).toHaveBeenCalledWith(connectionId);
    expect(connectionNode.children?.map((node) => node.label)).toEqual([`${dbType} child`]);
  });
});
