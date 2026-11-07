// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import { oracleDatabaseLinkGroup, oracleSchemaJobGroups } from "@/lib/sidebar/oracleObjectNavigation";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import * as api from "@/lib/backend/api";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import SidebarTreeItemDialogs from "@/components/sidebar/SidebarTreeItemDialogs.vue";
import { buildSidebarMenuLayout } from "@/lib/sidebar/sidebarMenuLayout";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...actual, listPlugins: vi.fn().mockResolvedValue([]), listDatabases: vi.fn().mockResolvedValue([{ name: "DB" }]), saveOpenTabsState: vi.fn().mockResolvedValue(undefined), executeQuery: vi.fn().mockResolvedValue({ columns: ["SESSION_USER"], rows: [["Owner"]] }) };
});

const apps: App[] = [];
const t = (key: string) => i18n.global.t(key);
const parent = { id: "c:DB:Owner", connectionId: "c", database: "DB", schema: "Owner" };
async function settle() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}
async function mountHost(node: TreeNode, config: Partial<ConnectionConfig> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.addEphemeralConnection({ id: "c", name: "Oracle", db_type: "oracle", host: "localhost", port: 1521, username: "Owner", password: "", database: "DB", ...config });
  store.treeNodes = node.type === "connection" ? [node] : [{ id: "c", type: "connection", label: "Oracle", connectionId: "c", children: [node] }];
  store.connectedIds.add("c");
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  vi.spyOn(store, "listOracleDatabaseLinks").mockResolvedValue([]);
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost>>();
  const dialogs = ref<Record<string, unknown> | null>(null);
  const root = defineComponent({
    setup: () => () =>
      h("div", [
        h(SidebarTreeRuntimeHost, {
          ref: host,
          node,
          depth: 0,
          onOpenDialogController: (controller) => {
            dialogs.value = controller;
          },
        }),
        dialogs.value ? h(SidebarTreeItemDialogs, { controller: dialogs.value }) : null,
      ]),
  });
  const element = document.createElement("div");
  document.body.appendChild(element);
  const app = createApp(root).use(pinia).use(i18n);
  app.mount(element);
  apps.push(app);
  await settle();
  return { host: host.value!, store, queries: useQueryStore(), settings: useSettingsStore() };
}
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function action(menu: ContextMenuItem[], label: string) {
  const entries = (items: ContextMenuItem[]): ContextMenuItem[] => items.flatMap((item) => [item, ...entries(item.children ?? [])]);
  const item = entries(menu).find((item) => item.label === t(label));
  expect(item, `missing menu item: ${label}`).toBeDefined();
  return item!;
}

describe("scoped object navigation through the original runtime and pages", () => {
  it("opens the persistent default draft and keeps new-query actions independent", async () => {
    const node: TreeNode = { id: "c", type: "connection", label: "Oracle", connectionId: "c", children: [] };
    const { host, queries } = await mountHost(node);
    const openDefault = vi.spyOn(queries, "openDefaultQuery").mockResolvedValue("default-draft");
    const create = vi.spyOn(queries, "createTab").mockReturnValue("fresh-query");
    const menu = host.buildContextMenu(node);
    await action(buildSidebarMenuLayout(menu, "connection", "grouped", [], t), "savedSql.openDefaultQuery").action?.();
    expect(openDefault).toHaveBeenCalledWith({ connectionId: "c", database: "DB" });
    expect(create).not.toHaveBeenCalled();
    await action(menu, "contextMenu.newQuery").action?.();
    await action(menu, "contextMenu.newQuery").action?.();
    expect(create).toHaveBeenCalledTimes(2);
    expect(openDefault).toHaveBeenCalledOnce();
  });

  it("opens frequent and recent SQL from the original saved file without executing it", async () => {
    const node: TreeNode = { id: "c", type: "connection", label: "Oracle", connectionId: "c", children: [] };
    const { host, queries } = await mountHost(node);
    const saved = useSavedSqlStore();
    const file = { id: "saved-file", name: "report.sql", connectionId: "c", database: "DB", sql: "SELECT 'retained saved SQL'", sqlLoaded: true, createdAt: "2026-11-03", updatedAt: "2026-11-03" };
    saved.files = [file, { ...file, id: "default-file", name: "default.sql", isDefaultQuery: true }];
    const open = vi.spyOn(queries, "openSavedSql").mockReturnValue("saved-tab");
    const usage = vi.spyOn(saved, "recordFileUsage").mockResolvedValue(undefined);
    const recent = action(host.buildContextMenu(node), "contextMenu.sqlHistory");
    expect(recent.children?.some((item) => item.label === "report.sql")).toBe(true);
    await recent.children!.find((item) => item.label === "report.sql")!.action?.();
    expect(open).toHaveBeenCalledWith(expect.objectContaining(file));
    expect(usage).toHaveBeenCalledWith(file.id);
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(saved.files[0].sql).toBe(file.sql);
  });

  it("confirms deletion of the saved connection configuration before removing anything", async () => {
    const node: TreeNode = { id: "c", type: "connection", label: "Oracle", connectionId: "c", children: [] };
    const { host, store } = await mountHost(node);
    const remove = vi.spyOn(store, "removeConnections").mockResolvedValue(undefined);
    await action(host.buildContextMenu(node), "contextMenu.deleteConnection").action?.();
    await settle();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("contextMenu.confirmDeleteConnectionConfig", { name: "Oracle" })));
    expect(remove).not.toHaveBeenCalled();
    [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === t("dangerDialog.cancel"))!.click();
    await settle();
    expect(remove).not.toHaveBeenCalled();
  });
  it.each(["group-tables", "native-job-group", "oracle-db-links"] as const)("refreshes a projected %s category through the existing keyboard refresh entry", async (type) => {
    const node: TreeNode = { id: "projected", type, label: "Objects", connectionId: "c", relationalNavigationSources: ["source-A", "source-B"] };
    const { host, store } = await mountHost(node);
    const refreshSources = vi.spyOn(store, "loadRelationalNavigationGroup").mockResolvedValue(undefined);
    const refreshRaw = vi.spyOn(store, "refreshTreeNode").mockResolvedValue(undefined);
    expect(host.refreshNode(node)).toBe(true);
    await settle();
    expect(refreshSources).toHaveBeenCalledWith(expect.objectContaining({ id: "projected" }), true);
    expect(refreshRaw).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it.each([
    [
      "oracle",
      [
        ["contextMenu.userAdmin", "users"],
        ["contextMenu.processList", "processlist"],
      ],
    ],
    [
      "mysql",
      [
        ["contextMenu.userAdmin", "users"],
        ["contextMenu.processList", "processlist"],
        ["contextMenu.serverDashboard", "mysql-dashboard"],
      ],
    ],
    [
      "postgres",
      [
        ["contextMenu.userAdmin", "users"],
        ["contextMenu.processList", "processlist"],
        ["contextMenu.serverDashboard", "postgres-dashboard"],
      ],
    ],
    [
      "xugu",
      [
        ["contextMenu.openXuguUserPermissions", "xugu-users"],
        ["processList.transactionTitle", "processlist"],
        ["contextMenu.serverDashboard", "xugu-dashboard"],
      ],
    ],
    [
      "dameng",
      [
        ["contextMenu.damengUsers", "dameng-users"],
        ["contextMenu.damengRoles", "dameng-roles"],
        ["contextMenu.damengJobAdmin", "dameng-jobs"],
      ],
    ],
  ] as const)("opens %s management through its original connection menu despite retired display flags", async (db_type, entries) => {
    const node: TreeNode = { id: "c", type: "connection", label: "Connection", connectionId: "c", children: [] };
    const { host, queries } = await mountHost(node, { db_type, username: db_type === "xugu" ? "SYSDBA" : "Owner", show_extensions: false, show_user_admin: false, show_native_jobs: false });
    const menu = host.buildContextMenu(node);
    for (const [label, mode] of entries) {
      await action(menu, label).action?.();
      await settle();
      expect(queries.tabs.some((tab) => tab.mode === mode && tab.connectionId === "c")).toBe(true);
    }
    expect(api.executeQuery).not.toHaveBeenCalled();
  });
  it("retains the original Xugu transaction privilege gate for an ordinary user", async () => {
    const node: TreeNode = { id: "c", type: "connection", label: "Connection", connectionId: "c", children: [] };
    const { host } = await mountHost(node, { db_type: "xugu", username: "Owner" });
    const menu = host.buildContextMenu(node);
    action(menu, "contextMenu.openXuguUserPermissions");
    expect(menu.some((item) => item.sidebarActionId === "contextMenu.processList")).toBe(false);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });
  it("offers the normal DB Link menu without opening a dialog, and opens scoped creation only on request", async () => {
    const group = oracleDatabaseLinkGroup(parent, { kind: "public" });
    const { host, store } = await mountHost(group);
    const menu = host.buildContextMenu(group);
    action(menu, "databaseLinks.create");
    action(menu, "tree.openList");
    action(menu, "contextMenu.refreshObjects");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.executeQuery).not.toHaveBeenCalled();
    await action(menu, "databaseLinks.create").action?.();
    await settle();
    expect(store.listOracleDatabaseLinks).toHaveBeenCalledWith("c", "DB", { kind: "public" });
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT SYS_CONTEXT"))).toBe(true);
  });

  it("opens a job category list or new form in the same fixed page without a connection overview", async () => {
    const group = oracleSchemaJobGroups(parent)[0]!.children!.find((node) => node.nativeJobPage?.kind === "legacy")!;
    const { host, queries } = await mountHost(group);
    const menu = host.buildContextMenu(group);
    await action(menu, "tree.openList").action?.();
    await settle();
    expect(queries.tabs).toHaveLength(1);
    expect(queries.tabs[0]).toMatchObject({ mode: "database-jobs", database: "DB", nativeJobPage: { schema: "Owner", kind: "legacy" } });
    await action(menu, "damengJobAdmin.newJob").action?.();
    await settle();
    expect(queries.tabs).toHaveLength(1);
    expect(queries.tabs[0]?.nativeJobCreateRequest).toBe(1);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("retains the single-scope table menu and refreshes its real source", async () => {
    const source: TreeNode = { id: `${parent.id}:__tables`, type: "group-tables", label: "tree.tables", connectionId: "c", database: "DB", schema: "Owner", children: [] };
    const { host, store } = await mountHost(source);
    store.treeNodes[0].children = [{ ...parent, type: "schema", label: "Owner", children: [source] }];
    const first = store.projectRelationalNavigationTree(store.treeNodes)[0];
    const selector = first.children!.find((node) => node.type === "relational-scope")!;
    store.setRelationalNavigationSelection(selector.relationalNavigationContainer!, { kind: "named", name: "Owner" });
    const displayed = store.projectRelationalNavigationTree(store.treeNodes)[0].children!.find((node) => node.type === "group-tables")!;
    const refresh = vi.spyOn(store, "refreshTreeNode").mockResolvedValue(undefined);
    const menu = host.buildContextMenu(displayed);
    action(menu, "contextMenu.createTable");
    await action(menu, "contextMenu.refreshObjects").action?.();
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ id: source.id, type: "group-tables", database: "DB", schema: "Owner" }));
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("opens exact job selections with normal double-click preference and no write side effects", async () => {
    const group = oracleSchemaJobGroups(parent)[0]!.children!.find((node) => node.nativeJobPage?.kind === "legacy")!;
    const node: TreeNode = { ...group, id: `${group.id}:900719925474099312345`, type: "native-job", label: "900719925474099312345", nativeJobSelection: { kind: "legacy", jobId: "900719925474099312345" } };
    const { host, queries, settings } = await mountHost(node);
    settings.editorSettings.sidebarActivation = "double";
    host.handleRowClick(node, 1);
    await settle();
    expect(queries.tabs).toHaveLength(0);
    host.handleRowDoubleClick(node, new MouseEvent("dblclick"));
    await settle();
    expect(queries.tabs[0]?.nativeJobAdmin).toEqual(node.nativeJobSelection);
    expect(queries.tabs[0]?.nativeJobPage).toEqual(group.nativeJobPage);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("uses the configured category activation and refreshes an object's original page scope", async () => {
    const group = oracleSchemaJobGroups(parent)[0]!.children!.find((node) => node.nativeJobPage?.kind === "legacy")!;
    const { host, store, settings } = await mountHost(group);
    const load = vi.spyOn(store, "loadTreeNodeChildren").mockResolvedValue(undefined);
    const refresh = vi.spyOn(store, "refreshNativeJobTree").mockResolvedValue(undefined);
    settings.editorSettings.sidebarActivation = "double";
    host.handleRowClick(group, 1);
    await settle();
    expect(load).not.toHaveBeenCalled();
    host.handleRowDoubleClick(group, new MouseEvent("dblclick"));
    await settle();
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ id: group.id, nativeJobPage: group.nativeJobPage }), undefined);
    const object: TreeNode = { ...group, id: `${group.id}:41`, type: "native-job", label: "41", nativeJobSelection: { kind: "legacy", jobId: "41" } };
    const menu = host.buildContextMenu(object);
    await action(menu, "contextMenu.refreshObjects").action?.();
    await settle();
    expect(refresh).toHaveBeenCalledWith("c", "DB", { schema: "Owner", kind: "legacy" });
    expect(api.executeQuery).not.toHaveBeenCalled();
  });
});
