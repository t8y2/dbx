// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    listPlugins: vi.fn().mockResolvedValue([]),
    saveTableVGroups: vi.fn().mockResolvedValue(undefined),
  };
});

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import SidebarTableVGroupDialog from "@/components/sidebar/SidebarTableVGroupDialog.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { tableVGroupScopeKey } from "@/lib/table/tableVGroup";
import { showTableVGroupDialog, tableVGroupName, tableVGroupDialogScope, tableVGroupDialogParentGroupId, tableVGroupDialogTableNames } from "@/components/sidebar/sidebarTreeDialogState";

const connection = { id: "pg-1", name: "PostgreSQL", db_type: "postgres", driver_profile: "postgresql", host: "localhost", port: 5432, username: "postgres", password: "" };
const mountedApps: App<Element>[] = [];
const tr = (key: string) => i18n.global.t(key);

async function mountHost() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connectionStore = useConnectionStore();
  connectionStore.connections = [connection];
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const root = defineComponent({
    setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: { id: `pg-1`, type: "connection", label: connection.name, connectionId: connection.id }, depth: 0 }),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(root);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mountedApps.push(app);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return host.value as { buildContextMenu(node: TreeNode): ContextMenuItem[] };
}

async function mountDialog() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(SidebarTableVGroupDialog);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mountedApps.push(app);
  await nextTick();
  return container;
}

describe("table virtual group context menus and dialog", () => {
  beforeEach(() => {
    showTableVGroupDialog.value = false;
    tableVGroupName.value = "";
    tableVGroupDialogScope.value = null;
    tableVGroupDialogParentGroupId.value = null;
    tableVGroupDialogTableNames.value = [];
  });

  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it.each(["connection", "doris-catalog"] as const)("can show a persisted hidden empty database group on %s", async (type) => {
    const host = await mountHost();
    const store = useConnectionStore();
    const container: TreeNode = { id: type === "connection" ? connection.id : `${connection.id}:catalog`, type, label: "Container", connectionId: connection.id, ...(type === "doris-catalog" ? { catalog: "external" } : {}), children: [] };
    store.treeNodes = type === "connection" ? [container] : [{ id: connection.id, type: "connection", label: connection.name, connectionId: connection.id, children: [container] }];
    const scope = { connectionId: connection.id, catalog: container.catalog, objectType: "databases" as const };
    // Same state as loading a hidden layout from disk with all databases filtered out.
    store.tableVGroupLayouts = { [tableVGroupScopeKey(scope)!]: { version: 1, enabled: false, groups: [{ id: "empty", name: "Empty", collapsed: false }], order: [{ type: "group", id: "empty", children: [] }] } };
    let toggle = host.buildContextMenu(container).find((item) => item.sidebarActionId === "databaseVGroup.toggleGroups");
    expect(toggle?.label).toBe(tr("tableVGroup.enableGroups"));
    toggle?.action?.();
    expect(container.children?.map((node) => node.label)).toEqual(["Empty"]);
    toggle = host.buildContextMenu(container).find((item) => item.sidebarActionId === "databaseVGroup.toggleGroups");
    expect(toggle?.label).toBe(tr("tableVGroup.disableGroups"));
    toggle?.action?.();
    expect(container.children).toEqual([]);
    expect(host.buildContextMenu(container).some((item) => item.sidebarActionId === "databaseVGroup.toggleGroups")).toBe(true);
  });

  it.each(["connection", "database", "redis-db", "mongo-db", "vector-database"] as const)("places database grouping below primary actions and ahead of trailing refresh or danger actions on %s", async (type) => {
    const host = await mountHost();
    const store = useConnectionStore();
    const dbType = type === "redis-db" ? "redis" : type === "mongo-db" ? "mongodb" : type === "vector-database" ? "milvus" : "postgres";
    store.connections = [{ ...connection, db_type: dbType }];
    const database: TreeNode = { id: `${connection.id}:app`, type: type === "connection" ? "database" : type, label: "app", connectionId: connection.id, database: "app", children: [] };
    const root: TreeNode = { id: connection.id, type: "connection", label: connection.name, connectionId: connection.id, children: [database] };
    store.treeNodes = [root];
    const items = host.buildContextMenu(type === "connection" ? root : database);
    const groupIndex = items.findIndex((item) => item.sidebarActionId?.startsWith("databaseVGroup."));
    const queryIndex = items.findIndex((item) => item.label === tr("contextMenu.newQuery"));
    const refreshIndex = items.findIndex((item) => item.label === tr("contextMenu.refreshChildren"));
    expect(queryIndex).toBeGreaterThanOrEqual(0);
    expect(groupIndex).toBeGreaterThan(queryIndex);
    if (type === "connection" || type === "database") {
      expect(refreshIndex).toBeGreaterThan(groupIndex);
    } else {
      // Redis/Mongo/Milvus menus have no refresh action; keep dangerous actions last.
      const dangerIndex = items.findIndex((item) => item.variant === "destructive");
      expect(dangerIndex).toBeGreaterThan(groupIndex);
    }
    expect(items[groupIndex - 1].separator).toBe(true);
    expect(items[groupIndex + 1].separator).toBe(true);
  });

  it("does not offer database folders for an empty connection without a database layout", async () => {
    const host = await mountHost();
    const node: TreeNode = { id: connection.id, type: "connection", label: connection.name, connectionId: connection.id, children: [] };
    useConnectionStore().treeNodes = [node];
    expect(host.buildContextMenu(node).some((item) => item.sidebarActionId?.startsWith("databaseVGroup."))).toBe(false);
  });

  it("provides 'New Group' on group-tables container and triggers dialog with empty selection", async () => {
    const host = await mountHost();
    const tablesGroupNode: TreeNode = {
      id: "pg-1:app:public:group-tables",
      type: "group-tables",
      label: "Tables",
      connectionId: connection.id,
      database: "app",
      schema: "public",
    };
    const items = host.buildContextMenu(tablesGroupNode);
    const createGroupItem = items.find((item) => item.label === tr("connectionGroup.createGroup"));
    expect(createGroupItem).toBeDefined();

    createGroupItem?.action?.();
    expect(showTableVGroupDialog.value).toBe(true);
    expect(tableVGroupDialogScope.value).toBe(tablesGroupNode);
    expect(tableVGroupDialogParentGroupId.value).toBeNull();
    expect(tableVGroupDialogTableNames.value).toEqual([]);
  });

  it("does not provide 'New Group' on database container in grouped mode (issue #13030)", async () => {
    const host = await mountHost();
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.sidebarObjectDisplay = "grouped";
    const databaseNode: TreeNode = {
      id: "pg-1:app",
      type: "database",
      label: "app",
      connectionId: connection.id,
      database: "app",
    };
    const items = host.buildContextMenu(databaseNode);
    const createGroupItem = items.find((item) => item.label === tr("connectionGroup.createGroup"));
    expect(createGroupItem).toBeUndefined();
  });

  it("provides 'New Group' on database container in simple mode", async () => {
    const host = await mountHost();
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.sidebarObjectDisplay = "simple";
    const databaseNode: TreeNode = {
      id: "pg-1:app",
      type: "database",
      label: "app",
      connectionId: connection.id,
      database: "app",
    };
    const items = host.buildContextMenu(databaseNode);
    const createGroupItem = items.find((item) => item.label === tr("connectionGroup.createGroup"));
    expect(createGroupItem).toBeDefined();
  });

  it("provides 'New Group' on group-views container", async () => {
    const host = await mountHost();
    const viewsGroupNode: TreeNode = {
      id: "pg-1:app:public:group-views",
      type: "group-views",
      label: "Views",
      connectionId: connection.id,
      database: "app",
      schema: "public",
    };
    const items = host.buildContextMenu(viewsGroupNode);
    const createGroupItem = items.find((item) => item.label === tr("connectionGroup.createGroup"));
    expect(createGroupItem).toBeDefined();
  });

  it("provides 'New Subgroup' on table-vgroup nodes", async () => {
    const host = await mountHost();
    const vgroupNode: TreeNode = {
      id: "table-vgroup:grp-1",
      type: "table-vgroup",
      label: "User Group",
      vgroupId: "grp-1",
      connectionId: connection.id,
      database: "app",
      schema: "public",
    };
    const items = host.buildContextMenu(vgroupNode);
    const newSubgroupItem = items.find((item) => item.label === tr("tableVGroup.newSubgroup"));
    expect(newSubgroupItem).toBeDefined();

    newSubgroupItem?.action?.();
    expect(showTableVGroupDialog.value).toBe(true);
    expect(tableVGroupDialogScope.value).toBe(vgroupNode);
    expect(tableVGroupDialogParentGroupId.value).toBe("grp-1");
    expect(tableVGroupDialogTableNames.value).toEqual([]);
  });

  it("lists existing groups for a search-projected table row the live tree does not contain (#14228)", async () => {
    const host = await mountHost();
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.sidebarObjectDisplay = "grouped";
    const connectionStore = useConnectionStore();
    connectionStore.treeNodes = [
      {
        id: connection.id,
        type: "connection",
        label: connection.name,
        connectionId: connection.id,
        children: [
          {
            id: `${connection.id}:app`,
            type: "database",
            label: "app",
            connectionId: connection.id,
            database: "app",
            children: [
              {
                id: `${connection.id}:app:public:group-tables`,
                type: "group-tables",
                label: "Tables",
                connectionId: connection.id,
                database: "app",
                schema: "public",
                children: [{ id: `${connection.id}:app:public:t_a`, label: "t_a", type: "table", connectionId: connection.id, database: "app", schema: "public" }],
              },
            ],
          },
        ],
      },
    ];
    const scope = { connectionId: connection.id, database: "app", schema: "public", objectType: "tables" as const };
    const groupId = connectionStore.createTableVGroup(scope, "Group A");
    expect(groupId).toBeTruthy();

    // 首页之外的表：搜索投影出该行，但 live 树里没有同 id 节点。
    const projectedRow: TreeNode = { id: `${connection.id}:app:public:t_hidden`, label: "t_hidden", type: "table", connectionId: connection.id, database: "app", schema: "public" };
    const items = host.buildContextMenu(projectedRow);
    const moveItem = items.find((item) => item.label === tr("tableVGroup.moveToGroup"));
    expect(moveItem).toBeDefined();
    const groupEntry = moveItem?.children?.find((child) => child.label === "Group A");
    expect(groupEntry).toBeDefined();
    expect(groupEntry?.disabled).toBe(false);

    groupEntry?.action?.();
    expect(connectionStore.tableVGroupPathForTable(scope, "t_hidden", "table")).toContain(groupId!);
  });

  it("dynamically sets the dialog title for container group creation, subgroup, and move-in", async () => {
    await mountDialog();
    showTableVGroupDialog.value = true;
    tableVGroupDialogTableNames.value = [];
    tableVGroupDialogParentGroupId.value = null;
    await nextTick();

    const getTitle = () => document.body.querySelector("[data-slot='dialog-title']")?.textContent?.trim();
    expect(getTitle()).toBe(tr("connectionGroup.createGroup"));

    tableVGroupDialogParentGroupId.value = "grp-1";
    await nextTick();
    expect(getTitle()).toBe(tr("tableVGroup.newSubgroup"));

    tableVGroupDialogTableNames.value = ["orders", "users"];
    await nextTick();
    expect(getTitle()).toBe(tr("tableVGroup.moveToNewGroup"));
  });
});
