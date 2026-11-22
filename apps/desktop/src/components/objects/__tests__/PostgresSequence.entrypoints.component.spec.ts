// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { createSidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import { compileConnectionTreeTestScript } from "@/components/sidebar/__tests__/connectionTreeTestScript";

const api = vi.hoisted(() => ({
  listSchemas: vi.fn(),
  listObjects: vi.fn(),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/backend/api", async (original) => ({
  ...(await original<typeof import("@/lib/backend/api")>()),
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
vi.mock("@/components/objects/PostgresSequenceDialog.vue", () => ({
  default: defineComponent({
    props: ["open", "connectionId", "database", "schema", "name"],
    emits: ["update:open", "saved"],
    setup:
      (props, { emit }) =>
      () =>
        props.open
          ? h("div", { "data-sequence-target": JSON.stringify([props.connectionId, props.database, props.schema, props.name]) }, [
              h("button", { "data-save-sequence": "", onClick: () => emit("saved") }, "save"),
              h("button", { "data-close-sequence": "", onClick: () => emit("update:open", false) }, "close"),
            ])
          : null,
  }),
}));
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";

const mounted: { app: App; host: HTMLElement }[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  invalidateObjectBrowserRowsCache({});
  api.listSchemas.mockResolvedValue(["browser_schema", " Exact Schema "]);
  api.listObjects.mockResolvedValue([{ name: ' seq"name ', schema: " Exact Schema ", object_type: "SEQUENCE" }]);
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function prepare(dbType: ConnectionConfig["db_type"]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: `sequence-${dbType}`, name: "Sequence", db_type: dbType, database: "configured_db", driver_profile: dbType === "jdbc" ? "postgresql" : undefined, transport_layers: [] } as ConnectionConfig;
  const store = useConnectionStore();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  useSettingsStore().updateEditorSettings({ sidebarMenuLayout: "full", objectBrowserViewMode: "list" });
  return { pinia, connection, store };
}
function mount(component: ComponentForTest, pinia: ReturnType<typeof createPinia>) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(component);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  return host;
}
type ComponentForTest = Parameters<typeof createApp>[0];

it.each(["postgres", "jdbc", "opengauss", "gaussdb", "kingbase", "oceanbase-oracle"] as const)("exposes the sidebar properties action only for native PostgreSQL (%s)", async (dbType) => {
  const { pinia, connection } = prepare(dbType);
  const node: TreeNode = { id: "sequence", label: ' seq"name ', objectName: ' seq"name ', postgresSequenceExactIdentity: true, type: "sequence", connectionId: connection.id, database: "target_db", schema: " Exact Schema " };
  const runtime = ref<InstanceType<typeof SidebarTreeRuntimeHost>>();
  const opened = vi.fn();
  mount({ render: () => h(SidebarTreeRuntimeHost, { ref: runtime, node, depth: 1, onOpenPostgresSequence: opened }) }, pinia);
  await nextTick();
  const menu = runtime.value!.buildContextMenu(node) as ContextMenuItem[];
  expect(menu.some((item) => item.label === i18n.global.t("contextMenu.viewSource"))).toBe(true);
  const properties = menu.find((item) => item.label === i18n.global.t("postgresSequence.title"));
  expect(!!properties).toBe(dbType === "postgres");
  if (!properties) return;
  const expected = { ...node };
  node.label = "recycled";
  node.schema = "elsewhere";
  await properties.action?.();
  expect(opened).toHaveBeenCalledWith(expect.objectContaining(expected));
});

it("rejects normalized legacy sequence cache entries in both the sidebar menu and dialog route", async () => {
  const { pinia, connection, store } = prepare("postgres");
  const node: TreeNode = { id: "old-sequence", label: "seq", objectName: "seq", type: "sequence", connectionId: connection.id, database: "target_db", schema: "public" };
  const runtime = ref<InstanceType<typeof SidebarTreeRuntimeHost>>();
  const emitted = vi.fn();
  mount({ render: () => h(SidebarTreeRuntimeHost, { ref: runtime, node, depth: 1, onOpenPostgresSequence: emitted }) }, pinia);
  await nextTick();
  const properties = (runtime.value!.buildContextMenu(node) as ContextMenuItem[]).find((item) => item.label === i18n.global.t("postgresSequence.title"))!;
  expect(properties.disabled).toBe(true);
  await properties.action?.();
  expect(emitted).not.toHaveBeenCalled();

  const beginSidebarAction = vi.fn();
  const target = ref<TreeNode | null>(null);
  const open = ref(false);
  const compiled = compileConnectionTreeTestScript(["openSidebarPostgresSequence"]);
  const route = new Function("store", "createSidebarActionTarget", "beginSidebarAction", "sidebarPostgresSequenceTarget", "sidebarPostgresSequenceOpen", `${compiled}; return openSidebarPostgresSequence;`)(store, createSidebarActionTarget, beginSidebarAction, target, open) as (
    node: TreeNode,
  ) => void;
  route(node);
  expect(beginSidebarAction).not.toHaveBeenCalled();
  expect(open.value).toBe(false);
  const refreshed: TreeNode = { ...node, objectName: " seq ", postgresSequenceExactIdentity: true };
  route(refreshed);
  expect(open.value).toBe(true);
  expect(target.value?.objectName).toBe(" seq ");
  refreshed.objectName = "recycled";
  expect(target.value?.objectName).toBe(" seq ");
});

it.each(["postgres", "jdbc", "opengauss", "gaussdb"] as const)("keeps source viewing and scopes the browser properties entry to PostgreSQL (%s)", async (dbType) => {
  const { pinia, connection, store } = prepare(dbType);
  const refreshTree = vi.spyOn(store, "refreshObjectListTreeNode").mockResolvedValue(undefined);
  const props = reactive({ connection, database: "target_db", schema: "browser_schema", selectedObjectFilter: "sequences" as const });
  const host = mount({ render: () => h(ObjectBrowser, props) }, pinia);
  await vi.waitFor(() => expect([...host.querySelectorAll<HTMLElement>("[title]")].some((element) => element.title === 'seq"name')).toBe(true));
  const row = [...host.querySelectorAll<HTMLElement>("[title]")].find((element) => element.title === 'seq"name')!.closest<HTMLElement>(".cursor-default")!;
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await nextTick();
  const menuButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")];
  expect(menuButtons.some((button) => button.textContent?.trim() === i18n.global.t("contextMenu.viewSource"))).toBe(true);
  const properties = menuButtons.find((button) => button.textContent?.trim() === i18n.global.t("postgresSequence.title"));
  expect(!!properties).toBe(dbType === "postgres");
  if (!properties) return;
  properties.click();
  await nextTick();
  expect(JSON.parse(host.querySelector("[data-sequence-target]")!.getAttribute("data-sequence-target")!)).toEqual([connection.id, "target_db", " Exact Schema ", ' seq"name ']);
  host.querySelector<HTMLButtonElement>("[data-save-sequence]")!.click();
  await vi.waitFor(() => expect(refreshTree).toHaveBeenCalledWith(connection.id, "target_db", " Exact Schema ", undefined));
  props.database = "different_db";
  await nextTick();
  expect(host.querySelector("[data-sequence-target]")).toBeNull();
});
