// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode } from "@/types/database";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listPlugins: vi.fn().mockResolvedValue([]),
  listDatabases: vi.fn().mockResolvedValue([]),
  buildDuckDbAttachDatabaseSql: vi.fn().mockResolvedValue("ATTACH 'new.duckdb' AS new"),
  buildSqliteAttachDatabaseSql: vi.fn().mockResolvedValue("ATTACH 'new.db' AS new"),
  executeQuery: vi.fn(),
}));
import * as api from "@/lib/backend/api";
import { open, save } from "@tauri-apps/plugin-dialog";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey } from "@/lib/sidebar/sidebarTreeRuntime";

const apps: App[] = [];
const oldNode: TreeNode = { id: "conn:old", type: "database", label: "old", connectionId: "conn", database: "old" };
const newNode: TreeNode = { ...oldNode, id: "conn:new", label: "new", database: "new" };
const connection: TreeNode = { id: "conn", isExpanded: true, type: "connection", label: "Test", connectionId: "conn", children: [oldNode, newNode] };
const flatten = (items: ContextMenuItem[]): ContextMenuItem[] => items.flatMap((item) => [item, ...flatten(item.children ?? [])]);

async function mount(dbType: "sqlite" | "duckdb", tableRows = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ id: "conn", name: "Test", db_type: dbType, driver_profile: dbType }];
  store.treeNodes = [{ ...connection, children: [oldNode, newNode].map((node) => (tableRows ? { ...node, type: "table" } : node)) }];
  store.selectedTreeNodeId = oldNode.id;
  store.selectedTreeNodeIds = [oldNode.id, connection.id];
  store.treeSelectionAnchorId = oldNode.id;
  store.connectionMultiSelectActive = true;
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  vi.spyOn(store, "updateConnection").mockResolvedValue(undefined);
  vi.spyOn(store, "ensureVisibleDatabase").mockResolvedValue(undefined);
  vi.spyOn(store, "loadDatabases").mockResolvedValue(undefined);
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost>>();
  const app = createApp(defineComponent({ setup: () => () => h("div", [h(SidebarTreeRuntimeHost, { ref: host, node: connection, depth: 0 }), ...[oldNode, newNode].map((node) => h(TreeItem, { node: tableRows ? { ...node, type: "table" } : node, depth: 1 }))]) }));
  app.use(pinia).use(i18n);
  app.provide(sidebarTreeRuntimeKey, createSidebarTreeRuntime());
  const container = document.createElement("div");
  document.body.append(container);
  app.mount(container);
  apps.push(app);
  await nextTick();
  const menu = host.value!.buildContextMenu(connection);
  const label = i18n.global.t(dbType === "duckdb" ? "contextMenu.createDuckDbFile" : "contextMenu.attachSqliteDatabase");
  const action = flatten(menu).find((item) => item.label === label)?.action;
  expect(action).toBeTypeOf("function");
  return { store, action: action!, row: (id: string) => container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)! };
}

beforeEach(() => {
  vi.mocked(open).mockResolvedValue("/tmp/new.db");
  vi.mocked(save).mockResolvedValue("/tmp/new.duckdb");
  vi.mocked(api.executeQuery).mockResolvedValue({ columns: [], rows: [] } as any);
});
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe.each(["sqlite", "duckdb"] as const)("%s attached database selection", (dbType) => {
  it("selects only the attached database and resets the range anchor and multi-select mode", async () => {
    const { store, action, row } = await mount(dbType);
    action();
    await vi.waitFor(() => expect(store.loadDatabases).toHaveBeenCalled());
    await nextTick();
    expect(store.selectedTreeNodeId).toBe(newNode.id);
    expect(store.selectedTreeNodeIds).toEqual([newNode.id]);
    expect(store.treeSelectionAnchorId).toBe(newNode.id);
    expect(store.connectionMultiSelectActive).toBe(false);
    expect(row(newNode.id).classList.contains("tree-item-active")).toBe(true);
    expect(row(oldNode.id).classList.contains("tree-item-active")).toBe(false);
  });

  it.each(["cancel", "failure"])("keeps the original selection on %s", async (outcome) => {
    const { store, action } = await mount(dbType);
    if (outcome === "cancel") {
      vi.mocked(open).mockResolvedValue(null);
      vi.mocked(save).mockResolvedValue(null);
    } else {
      vi.mocked(api.executeQuery).mockRejectedValueOnce(new Error("attach failed"));
    }
    action();
    await vi.waitFor(() => expect(dbType === "duckdb" ? save : open).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (outcome === "failure") expect(api.executeQuery).toHaveBeenCalledOnce();
    else expect(api.executeQuery).not.toHaveBeenCalled();
    expect(store.loadDatabases).not.toHaveBeenCalled();
    expect(store.selectedTreeNodeId).toBe(oldNode.id);
    expect(store.selectedTreeNodeIds).toEqual([oldNode.id, connection.id]);
    expect(store.treeSelectionAnchorId).toBe(oldNode.id);
    expect(store.connectionMultiSelectActive).toBe(true);
  });
});

it.each(["ctrlKey", "metaKey"])("does not highlight a lead row toggled out with %s", async (modifier) => {
  const { store, row } = await mount("sqlite", true);
  store.selectedTreeNodeIds = [oldNode.id, newNode.id];
  store.selectedTreeNodeId = newNode.id;
  store.connectionMultiSelectActive = false;
  await nextTick();
  row(newNode.id).dispatchEvent(new MouseEvent("click", { bubbles: true, [modifier]: true }));
  await nextTick();
  expect(store.selectedTreeNodeId).toBe(newNode.id);
  expect(store.selectedTreeNodeIds).toEqual([oldNode.id]);
  expect(row(newNode.id).classList.contains("tree-item-active")).toBe(false);
  expect(row(oldNode.id).classList.contains("tree-item-active")).toBe(true);
});
