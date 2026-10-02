// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const mocks = vi.hoisted(() => ({
  target: { tableName: "orders.with.dots", tableType: "VIEW", schema: "row_schema", catalog: "external_catalog" } as { tableName: string; tableType: string; schema?: string; catalog?: string },
}));

vi.mock("splitpanes", () => ({
  Splitpanes: { template: "<div><slot /></div>" },
  Pane: { template: "<div><slot /></div>" },
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/layout/EditorToolbar.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/layout/QueryResultSurface.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/layout/EditorGroupTabBar.vue", () => ({
  default: defineComponent({
    props: { tabs: { type: Array as PropType<QueryTab[]>, required: true } },
    emits: ["locate-tab"],
    setup(props, { emit }) {
      return () => h("button", { "data-test": "locate-active-tab", onClick: () => emit("locate-tab", props.tabs[0]) }, "Locate tab");
    },
  }),
}));
vi.mock("@/components/objects/ObjectBrowser.vue", () => ({
  __esModule: true,
  default: defineComponent({
    emits: ["locateTable", "openTable"],
    setup(_, { emit }) {
      return () => h("button", { "data-test": "locate-object-row", onClick: () => emit("locateTable", mocks.target) }, "Locate row");
    },
  }),
}));

import SqlEditorWorkspace from "@/components/layout/SqlEditorWorkspace.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { activeTabSidebarTarget } from "@/lib/sidebar/sidebarActiveTabTarget";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  mocks.target = { tableName: "orders.with.dots", tableType: "VIEW", schema: "row_schema", catalog: "external_catalog" };
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  window.localStorage?.clear();
});

async function mountWorkspace(options: { dbType?: "postgres" | "mongodb"; contentSuppressed?: boolean } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "browser-connection", name: "Browser connection", db_type: options.dbType ?? "postgres" } as ConnectionConfig;
  useConnectionStore().connections = [connection];
  const queryStore = useQueryStore();
  const tab: QueryTab = {
    id: "objects-tab",
    title: "Database objects",
    connectionId: connection.id,
    database: "browser_database",
    mode: "objects",
    schema: "stale_schema",
    catalog: "stale_catalog",
    sql: "",
    isExecuting: false,
    objectBrowser: { schema: "browser_schema", catalog: "external_catalog" },
  };
  queryStore.tabs = [tab];
  queryStore.activeTabId = tab.id;
  queryStore.groups = [{ id: "g1", tabIds: [tab.id], activeTabId: tab.id }];
  queryStore.focusedGroupId = "g1";
  queryStore.sizes = [100];
  const host = document.createElement("div");
  document.body.append(host);
  const onLocateTab = vi.fn();
  const onOpenObjectTable = vi.fn();
  const app = createApp(SqlEditorWorkspace, {
    activeTab: tab,
    activeConnection: connection,
    activeOutputView: "result",
    executableSql: "",
    formatSqlRequest: null,
    compressSqlRequest: null,
    selectedSql: "",
    cursorPos: 0,
    blockDangerousRedisCommands: false,
    showTabNavigation: true,
    contentSuppressed: options.contentSuppressed,
    onLocateTab,
    onOpenObjectTable,
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector(options.contentSuppressed ? '[data-test="locate-active-tab"]' : '[data-test="locate-object-row"]')).not.toBeNull());
  return { host, queryStore, tab, onLocateTab, onOpenObjectTable };
}

describe("Object browser locate event through ContentArea and the workspace", () => {
  it.each(["TABLE", "VIEW", "MATERIALIZED_VIEW"])("forwards the full %s identity once without changing tabs", async (tableType) => {
    mocks.target.tableType = tableType;
    const { host, queryStore, tab, onLocateTab, onOpenObjectTable } = await mountWorkspace();
    host.querySelector<HTMLButtonElement>('[data-test="locate-object-row"]')!.click();
    await nextTick();

    expect(onLocateTab).toHaveBeenCalledExactlyOnceWith({
      id: tab.id,
      title: "orders.with.dots",
      connectionId: "browser-connection",
      database: "browser_database",
      schema: "row_schema",
      catalog: "external_catalog",
      mode: "data",
      sql: "",
      isExecuting: false,
      tableMeta: { ...mocks.target, columns: [], primaryKeys: [] },
    });
    expect(activeTabSidebarTarget(onLocateTab.mock.calls[0]![0])).toEqual({ type: "table", connectionId: "browser-connection", database: "browser_database", schema: "row_schema", tableName: "orders.with.dots" });
    expect(onOpenObjectTable).not.toHaveBeenCalled();
    expect(queryStore.tabs).toEqual([tab]);
    expect(queryStore.activeTabId).toBe(tab.id);
    expect(tab.mode).toBe("objects");
    expect(tab.schema).toBe("stale_schema");
  });

  it("does not inherit a stale schema or catalog when the row has neither", async () => {
    mocks.target = { tableName: "orders", tableType: "TABLE" };
    const { host, onLocateTab } = await mountWorkspace();
    host.querySelector<HTMLButtonElement>('[data-test="locate-object-row"]')!.click();

    expect(onLocateTab).toHaveBeenCalledOnce();
    expect(onLocateTab.mock.calls[0]![0]).toMatchObject({ schema: undefined, catalog: undefined, tableMeta: { tableName: "orders", tableType: "TABLE" } });
  });

  it("uses the existing MongoDB collection target for collection and view rows", async () => {
    const { host, onLocateTab, onOpenObjectTable } = await mountWorkspace({ dbType: "mongodb" });
    host.querySelector<HTMLButtonElement>('[data-test="locate-object-row"]')!.click();

    expect(onLocateTab).toHaveBeenCalledOnce();
    expect(activeTabSidebarTarget(onLocateTab.mock.calls[0]![0])).toEqual({ type: "mongo-collection", connectionId: "browser-connection", database: "browser_database", collectionName: "orders.with.dots" });
    expect(onOpenObjectTable).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves active-tab locate exactly once with suppressed content = %s", async (contentSuppressed) => {
    const { host, queryStore, onLocateTab, onOpenObjectTable } = await mountWorkspace({ contentSuppressed });
    host.querySelector<HTMLButtonElement>('[data-test="locate-active-tab"]')!.click();

    expect(onLocateTab).toHaveBeenCalledExactlyOnceWith(queryStore.tabs[0]);
    expect(onOpenObjectTable).not.toHaveBeenCalled();
  });
});
