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
