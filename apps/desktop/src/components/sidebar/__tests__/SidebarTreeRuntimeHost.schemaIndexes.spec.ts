// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { ConnectionConfig, DatabaseType, TreeNode } from "@/types/database";

const api = vi.hoisted(() => ({ executeQuery: vi.fn(), executeBatch: vi.fn(), buildDropTableChildObjectSql: vi.fn().mockResolvedValue("DROP INDEX unsafe") }));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<object>()), ...api, listPlugins: vi.fn().mockResolvedValue([]), saveSidebarLayout: vi.fn().mockResolvedValue(undefined) }));
import SidebarTreeRuntimeHost from "../SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { showDropTableChildObjectConfirm, showBatchDropConfirm, batchDropTargets } from "../sidebarTreeDialogState";

const mounted: { app: App; container: HTMLElement }[] = [];
const tr = (key: string) => i18n.global.t(key);
const indexNode = (extra: Partial<TreeNode> = {}): TreeNode => ({
  id: "index-1",
  type: "index",
  objectScope: "schema",
  label: " Ix (a)  (display only)",
  objectName: " Ix (a) ",
  connectionId: "c",
  database: "service",
  schema: " Owner ",
  parentSchema: " Owner ",
  parentName: " T (1) ",
  tableName: " T (1) ",
  ...extra,
});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  showDropTableChildObjectConfirm.value = false;
  showBatchDropConfirm.value = false;
  batchDropTargets.value = [];
});
afterEach(() => {
  for (const { app, container } of mounted.splice(0)) {
    app.unmount();
    container.remove();
  }
});

async function mountHost(node: TreeNode, dbType: DatabaseType = "oracle", readOnly = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ id: "c", name: "Index test", db_type: dbType, database: "service", username: "OWNER", read_only: readOnly } as ConnectionConfig];
  store.connectedIds.add("c");
  store.treeNodes = [node];
  store.selectedTreeNodeId = node.id;
  store.selectedTreeNodeIds = [node.id];
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  const queries = useQueryStore();
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const danger: { confirm: () => Promise<unknown> }[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    setup: () => () =>
      h(SidebarTreeRuntimeHost, {
        ref: host,
        node,
        depth: 0,
        onOpenDangerDialog: (request: any) => {
          danger.push(request);
        },
      }),
  })
    .use(pinia)
    .use(i18n);
  app.mount(container);
  mounted.push({ app, container });
  await nextTick();
  return { host: host.value!, store, queries, danger };
}

it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("opens an empty %s Schema index group for creation without DDL", async (dbType) => {
  const node = indexNode({ id: "group", type: "group-database-indexes", objectScope: undefined, tableName: undefined, parentName: undefined, parentSchema: undefined });
  const { host, queries } = await mountHost(node, dbType);
  const item = host.buildContextMenu(node).find((entry: ContextMenuItem) => entry.label === tr("structureEditor.addIndex"));
  expect(item).toBeDefined();
  await item?.action?.();
  expect(queries.tabs.at(-1)).toMatchObject({ mode: "objects", database: "service", objectBrowser: { schema: " Owner ", initialObjectFilter: "indexes", indexCreateRequestId: expect.any(Number) } });
  expect(api.executeQuery).not.toHaveBeenCalled();
  expect(api.executeBatch).not.toHaveBeenCalled();
});

it("routes menu, double click and Delete to one exact parent draft, never the generic DROP consumer", async () => {
  const node = indexNode();
  const { host, queries, danger } = await mountHost(node);
  host.handleRowDoubleClick(node, new MouseEvent("dblclick"));
  await nextTick();
  expect(queries.tabs.at(-1)).toMatchObject({ mode: "structure", schema: " Owner ", structureTableName: " T (1) ", structureExactIdentity: true, structureInitialTarget: { kind: "index", name: " Ix (a) ", owner: " Owner " } });
  host
    .buildContextMenu(node)
    .find((entry: ContextMenuItem) => entry.label === tr("contextMenu.dropIndex"))
    ?.action?.();
  await nextTick();
  expect(queries.tabs).toHaveLength(1);
  expect(queries.tabs[0]?.structureInitialTarget).toMatchObject({ name: " Ix (a) ", owner: " Owner ", action: "delete" });
  expect(showDropTableChildObjectConfirm.value).toBe(false);
  host.handleRowKeydown(node, new KeyboardEvent("keydown", { key: "Delete" }));
  await nextTick();
  expect(queries.tabs[0]?.structureInitialTarget).toMatchObject({ action: "delete" });
  expect(danger).toHaveLength(0);
  showDropTableChildObjectConfirm.value = true;
  await nextTick();
  await danger.at(-1)?.confirm();
  expect(api.executeQuery).not.toHaveBeenCalled();
  expect(api.executeBatch).not.toHaveBeenCalled();
});

it.each([{ parentSchema: "Other Owner" }, { parentSchema: undefined }, { parentName: undefined }])("blocks destructive paths for a cross-owner or unknown-parent index %j", async (extra) => {
  const node = indexNode(extra);
  const { host, queries, danger } = await mountHost(node);
  const menu = host.buildContextMenu(node);
  expect(menu.some((entry: ContextMenuItem) => entry.label === tr("contextMenu.dropIndex") || entry.label === tr("contextMenu.editIndex"))).toBe(false);
  host.handleRowKeydown(node, new KeyboardEvent("keydown", { key: "Delete" }));
  await nextTick();
  expect(showDropTableChildObjectConfirm.value).toBe(false);
  expect(queries.tabs).toHaveLength(0);
  expect(danger).toHaveLength(0);
  if (extra.parentSchema) {
    host.handleRowDoubleClick(node, new MouseEvent("dblclick"));
    await nextTick();
    expect(queries.tabs.at(-1)).toMatchObject({ mode: "objects", objectBrowser: { initialViewTarget: { name: " Ix (a) ", parentSchema: "Other Owner", parentName: " T (1) " } } });
  }
  expect(api.executeQuery).not.toHaveBeenCalled();
});

it.each(["same", "mixed"])("does not batch DROP a %s selection containing a Schema index, including stale confirmation", async (kind) => {
  const first = indexNode();
  const second = kind === "same" ? indexNode({ id: "index-2", objectName: "OTHER" }) : indexNode({ id: "table", type: "table", objectScope: undefined, label: "OTHER" });
  const { host, store, danger } = await mountHost(first);
  store.treeNodes = [first, second];
  store.selectedTreeNodeIds = [first.id, second.id];
  const menu = host.buildContextMenu(first);
  menu.find((entry: ContextMenuItem) => entry.variant === "destructive")?.action?.();
  await nextTick();
  expect(showBatchDropConfirm.value).toBe(false);
  expect(showDropTableChildObjectConfirm.value).toBe(false);
  host.handleRowKeydown(first, new KeyboardEvent("keydown", { key: "Delete" }));
  await nextTick();
  expect(showBatchDropConfirm.value).toBe(false);
  expect(danger).toHaveLength(0);
  batchDropTargets.value = [first, second];
  showBatchDropConfirm.value = true;
  await nextTick();
  await danger.at(-1)?.confirm();
  expect(api.executeQuery).not.toHaveBeenCalled();
  expect(api.executeBatch).not.toHaveBeenCalled();
});

it("keeps the existing table-child index deletion contract", async () => {
  const node = indexNode({ objectScope: undefined, schema: "OWNER", label: "IX_OLD", objectName: "IX_OLD", tableName: "T" });
  const { host, danger } = await mountHost(node, "firebird");
  host
    .buildContextMenu(node)
    .find((entry: ContextMenuItem) => entry.label === tr("contextMenu.dropIndex"))
    ?.action?.();
  await nextTick();
  expect(danger).toHaveLength(1);
});
