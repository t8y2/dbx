// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

const api = vi.hoisted(() => ({ listSchemas: vi.fn(), listObjects: vi.fn(), checkConnectionHealth: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  ...api,
  listPlugins: vi.fn().mockResolvedValue([]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  prewarmConnection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: ["items"],
    setup:
      (props, { slots }) =>
      () =>
        h(
          "div",
          props.items.map((item: unknown) => slots.default?.({ item })),
        ),
  }),
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
import SidebarTreeRuntimeHost from "../SidebarTreeRuntimeHost.vue";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const mounted: { app: App; container: HTMLElement }[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.listSchemas.mockResolvedValue(["SYS", "APP_OWNER"]);
  api.listObjects.mockImplementation(async (_id, _database, schema) => (schema === "APP_OWNER" || schema === "node_database" ? [{ name: "TARGET_TABLE", schema, object_type: "TABLE" }] : []));
});
afterEach(() => {
  for (const { app, container } of mounted.splice(0)) {
    app.unmount();
    container.remove();
  }
});

it.each([
  ["oceanbase-oracle", "SYS", "APP_OWNER", "SYS"],
  ["oracle", "SYS", "APP_OWNER", "SYS"],
  ["dameng", "SYS", "APP_OWNER", "SYS"],
  ["oracle", "", "APP_OWNER", "APP_OWNER"],
  ["oceanbase-oracle", "", "APP_OWNER", "APP_OWNER"],
  ["postgres", "configured", "node_database", "node_database"],
  ["mysql", "configured", "node_database", "node_database"],
] as const)("opens %s schema objects with configured database %s and node database %s", async (dbType, configuredDatabase, nodeDatabase, expectedDatabase) => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = {
    id: `schema-browser-${dbType}-${configuredDatabase}`,
    name: "Schema browser",
    db_type: dbType,
    database: configuredDatabase,
    username: "SYS",
    transport_layers: [],
    visible_databases: ["SYS"],
    visible_schemas: { [expectedDatabase]: ["APP_OWNER"] },
  } as unknown as ConnectionConfig;
  const store = useConnectionStore();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  const queries = useQueryStore();
  const node: TreeNode = { id: `${connection.id}:${nodeDatabase}:APP_OWNER`, label: "APP_OWNER", type: "schema", connectionId: connection.id, database: nodeDatabase, schema: "APP_OWNER" };
  const runtime = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    setup: () => () => {
      const tab = queries.tabs.find((item) => item.mode === "objects");
      return h("div", [h(SidebarTreeRuntimeHost, { ref: runtime, node, depth: 1 }), tab ? h(ObjectBrowser, { connection, database: tab.database, schema: tab.objectBrowser?.schema }) : null]);
    },
  });
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mounted.push({ app, container });
  await nextTick();
  const host = runtime.value as unknown as { buildContextMenu(node: TreeNode): ContextMenuItem[] };
  const action = host.buildContextMenu(node).find((item) => item.label === i18n.global.t("contextMenu.openObjectBrowser"))?.action;
  expect(action).toBeDefined();
  await action?.();
  expect(queries.tabs.find((item) => item.mode === "objects")).toMatchObject({ database: expectedDatabase, schema: "APP_OWNER" });
  await vi.waitFor(() => expect(container.textContent).toContain("TARGET_TABLE"));
  expect(api.listObjects.mock.calls.at(-1)?.slice(0, 3)).toEqual([connection.id, expectedDatabase, dbType === "mysql" ? "node_database" : "APP_OWNER"]);
});

it("links database and category clicks to one active object page with isolated databases", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "linked-mysql", name: "MySQL", db_type: "mysql", database: "app", transport_layers: [] } as unknown as ConnectionConfig;
  const store = useConnectionStore();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  const queries = useQueryStore();
  const database: TreeNode = { id: "linked-mysql:app", label: "app", type: "database", connectionId: connection.id, database: "app", isExpanded: true };
  const tables: TreeNode = { ...database, id: `${database.id}:tables`, type: "group-tables", label: "Tables" };
  const views: TreeNode = { ...database, id: `${database.id}:views`, type: "group-views", label: "Views" };
  api.listObjects.mockResolvedValue([
    { name: "linked_table", object_type: "TABLE" },
    { name: "linked_view", object_type: "VIEW" },
  ]);
  const runtime = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    setup: () => () => {
      const tab = queries.tabs.find((item) => item.id === queries.activeTabId);
      return h("div", [
        h(SidebarTreeRuntimeHost, { ref: runtime, node: database, depth: 0 }),
        tab?.mode === "objects"
          ? h(ObjectBrowser, {
              key: tab.id,
              connection,
              database: tab.database,
              selectedObjectFilter: tab.objectBrowser?.filter,
              onFilterChange: (filter) => queries.updateObjectBrowserFilter(tab.id, filter),
            })
          : null,
      ]);
    },
  });
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mounted.push({ app, container });
  await nextTick();

  runtime.value?.handleRowClick(database, 1);
  await vi.waitFor(() => expect(container.querySelector('[title="linked_table"]')).not.toBeNull());
  const tabId = queries.activeTabId;
  runtime.value?.handleRowClick(views, 1);
  await vi.waitFor(() => {
    expect(container.querySelector('[title="linked_view"]')).not.toBeNull();
    expect(container.querySelector('[title="linked_table"]')).toBeNull();
  });
  expect(queries.activeTabId).toBe(tabId);

  runtime.value?.handleRowClick(tables, 1);
  await vi.waitFor(() => {
    expect(container.querySelector('[title="linked_table"]')).not.toBeNull();
    expect(container.querySelector('[title="linked_view"]')).toBeNull();
  });
  expect(queries.tabs.filter((tab) => tab.mode === "objects")).toHaveLength(1);

  queries.createTab(connection.id, "app", "Query");
  runtime.value?.handleRowClick(database, 1);
  await vi.waitFor(() => expect(queries.activeTabId).toBe(tabId));

  const otherDatabase: TreeNode = { ...database, id: "linked-mysql:other", label: "other", database: "other" };
  runtime.value?.handleRowClick(otherDatabase, 1);
  await vi.waitFor(() => expect(queries.tabs.find((tab) => tab.id === queries.activeTabId)?.database).toBe("other"));
  expect(queries.activeTabId).not.toBe(tabId);
});
