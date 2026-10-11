// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...actual, listPlugins: vi.fn().mockResolvedValue([]) };
});

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { buildSidebarMenuLayout } from "@/lib/sidebar/sidebarMenuLayout";

const mysqlConnection = {
  id: "conn-mysql",
  name: "MySQL Test",
  db_type: "mysql",
  driver_profile: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "",
};

const nacosConnection = {
  id: "conn-nacos",
  name: "Nacos Test",
  db_type: "nacos",
  driver_profile: "nacos",
  host: "localhost",
  port: 8848,
  username: "",
  password: "",
};

const mountedApps: App<Element>[] = [];

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountHost(connection = mysqlConnection) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connectionStore = useConnectionStore();
  connectionStore.connections = [connection];

  const rootNode: TreeNode = {
    id: connection.id,
    label: connection.name,
    type: "connection",
    connectionId: connection.id,
  };

  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: rootNode, depth: 0 }) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(root);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mountedApps.push(app);
  await flush();
  return host.value as unknown as { buildContextMenu(node: TreeNode): ContextMenuItem[] };
}

function menuLabels(items: ContextMenuItem[]): string[] {
  return items.flatMap((item) => [...(item.label ? [item.label] : []), ...(item.children ? menuLabels(item.children) : [])]);
}

const tr = (key: string) => i18n.global.t(key);

describe("SidebarTreeRuntimeHost saved SQL context menu (#9127)", () => {
  it.each(["mysql", "oracle"])("shares the primary visible-filter preference for %s connections", async (dbType) => {
    const connection = { ...mysqlConnection, db_type: dbType, driver_profile: dbType };
    const host = await mountHost(connection);
    const raw = host.buildContextMenu({ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id });
    const filter = raw.find((entry) => entry.sidebarActionId === "contextMenu.configureVisibleObjects");
    expect(filter?.label).toBe(tr(dbType === "oracle" ? "visibleSchemas.title" : "contextMenu.configureVisibleObjects"));
    const grouped = buildSidebarMenuLayout(raw, "connection", "grouped", [], tr, { order: ["contextMenu.configureVisibleObjects"] });
    expect(grouped[0]).toBe(filter);
    const hidden = buildSidebarMenuLayout(raw, "connection", "grouped", [], tr, { hiddenPrimaryIds: ["contextMenu.configureVisibleObjects"] });
    expect(hidden).not.toContain(filter);
    expect(hidden.find((entry) => entry.sidebarActionId === "group.organize")?.children).toContainEqual(expect.objectContaining({ action: filter!.action }));
  });

  it.each(["mysql", "postgres", "oracle", "sqlserver"])("puts database search in data tools and pinning directly in %s database and table menus", async (dbType) => {
    const host = await mountHost({ ...mysqlConnection, db_type: dbType, driver_profile: dbType });
    for (const type of ["database", "table"] as const) {
      const raw = host.buildContextMenu({ id: `app:${type}`, label: "app", type, connectionId: mysqlConnection.id, database: "app", schema: "public" });
      const grouped = buildSidebarMenuLayout(raw, type, "grouped", [], tr);
      const pin = raw.find((entry) => entry.sidebarActionId === "sidebar.togglePinnedObject");
      expect(pin).toBeDefined();
      expect(grouped).toContain(pin);
      if (type === "database") {
        const search = raw.find((entry) => entry.sidebarActionId === "databaseSearch.open");
        expect(search).toBeDefined();
        expect(grouped.find((entry) => entry.sidebarActionId === "group.data")?.children).toContainEqual(search);
        expect(grouped.some((entry) => entry.sidebarActionId === "group.manage")).toBe(false);
      }
    }
  });

  it("groups real table actions without losing callbacks and binds a promoted query to its original target", async () => {
    const host = await mountHost(mysqlConnection);
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    vi.spyOn(connectionStore, "ensureConnected").mockResolvedValue(undefined as any);
    const createTabSpy = vi.spyOn(queryStore, "createTab").mockReturnValue("menu-query");
    const node: TreeNode = { id: "orders", label: "orders", type: "table", connectionId: mysqlConnection.id, database: "app", schema: "public" };
    const raw = host.buildContextMenu(node);
    const grouped = buildSidebarMenuLayout(raw, "table", "grouped", ["contextMenu.exportData"], tr);
    expect(grouped.find((item) => item.sidebarActionId === "contextMenu.exportData")?.children?.some((item) => item.label === "CSV")).toBe(true);
    expect(grouped.find((item) => item.label === tr("sidebarMenu.groups.danger"))?.children?.some((item) => item.sidebarActionId === "contextMenu.dropTable")).toBe(true);
    const callbacks = (items: ContextMenuItem[]): Array<ContextMenuItem["action"]> => items.flatMap((item) => (item.children?.length ? callbacks(item.children) : item.action ? [item.action] : []));
    expect(callbacks(grouped)).toHaveLength(callbacks(raw).length);
    expect(callbacks(grouped)).toEqual(expect.arrayContaining(callbacks(raw)));
    node.database = "changed-after-open";
    await grouped.find((item) => item.sidebarActionId === "contextMenu.newQuery")?.action?.();
    expect(createTabSpy.mock.calls[0].slice(0, 7)).toEqual([mysqlConnection.id, "app", undefined, "query", "public", undefined, undefined]);
  });
  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("includes new query option on saved-sql-root node and executes newQuery with database context", async () => {
    const host = await mountHost(mysqlConnection);
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    vi.spyOn(connectionStore, "ensureConnected").mockResolvedValue(undefined as any);
    const createTabSpy = vi.spyOn(queryStore, "createTab").mockReturnValue("tab-1");

    const savedSqlRootNode: TreeNode = {
      id: "conn-mysql:app:__queries",
      label: "tree.queries",
      type: "saved-sql-root",
      connectionId: mysqlConnection.id,
      database: "app",
      catalog: "def",
      schema: "public",
    };

    const items = host.buildContextMenu(savedSqlRootNode);
    expect(menuLabels(items)).toContain(tr("contextMenu.newQuery"));
    expect(menuLabels(items)).toContain(tr("savedSql.pasteFile"));

    const newQueryItem = items.find((item) => item.label === tr("contextMenu.newQuery"));
    expect(newQueryItem).toBeDefined();

    await newQueryItem?.action?.();
    expect(createTabSpy).toHaveBeenCalledWith("conn-mysql", "app", undefined, "query", "public", undefined, "def");
  });

  it("includes new query option on saved-sql-file node", async () => {
    const host = await mountHost(mysqlConnection);
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    vi.spyOn(connectionStore, "ensureConnected").mockResolvedValue(undefined as any);
    const createTabSpy = vi.spyOn(queryStore, "createTab").mockReturnValue("tab-2");

    const savedSqlFileNode: TreeNode = {
      id: "conn-mysql:app:__queries:file:q1",
      label: "select_users.sql",
      type: "saved-sql-file",
      connectionId: mysqlConnection.id,
      database: "app",
      schema: "public",
      savedSqlId: "q1",
    };

    const items = host.buildContextMenu(savedSqlFileNode);
    expect(menuLabels(items)).toContain(tr("savedSql.open"));
    expect(menuLabels(items)).toContain(tr("contextMenu.newQuery"));
    expect(menuLabels(items)).toContain(tr("savedSql.copyFile"));
    expect(menuLabels(items)).toContain(tr("savedSql.pasteFile"));

    const newQueryItem = items.find((item) => item.label === tr("contextMenu.newQuery"));
    expect(newQueryItem).toBeDefined();

    await newQueryItem?.action?.();
    expect(createTabSpy).toHaveBeenCalledWith("conn-mysql", "app", undefined, "query", "public", undefined, undefined);
  });

  it("omits new query option on saved-sql-root when database type does not support queries", async () => {
    const host = await mountHost(nacosConnection);

    const savedSqlRootNode: TreeNode = {
      id: "conn-nacos:app:__queries",
      label: "tree.queries",
      type: "saved-sql-root",
      connectionId: nacosConnection.id,
      database: "app",
    };

    const items = host.buildContextMenu(savedSqlRootNode);
    expect(menuLabels(items)).not.toContain(tr("contextMenu.newQuery"));
    expect(menuLabels(items)).toContain(tr("savedSql.pasteFile"));
  });
});
