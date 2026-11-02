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
