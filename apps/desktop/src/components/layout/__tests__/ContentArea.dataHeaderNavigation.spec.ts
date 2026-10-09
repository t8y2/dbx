// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryTab } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/transfer/QueryResultTransferDialog.vue", () => ({ __esModule: true, default: { render: () => null } }));
const mocks = vi.hoisted(() => ({ openTableStructureEditor: vi.fn(() => true) }));
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: {
    setup(_props: unknown, { expose }: { expose: (value: unknown) => void }) {
      expose({ canOpenTableStructureEditor: true, openTableStructureEditor: mocks.openTableStructureEditor });
      return () => null;
    },
  },
}));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const connection: ConnectionConfig = {
  id: "sqlserver-prd",
  name: "辽宁-prd",
  db_type: "sqlserver",
  host: "localhost",
  port: 1433,
  username: "sa",
  password: "",
};

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  localStorage.clear();
});

async function mountDataTab() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useConnectionStore().connections = [connection];
  const store = useQueryStore();
  const tab = reactive<QueryTab>({
    id: "abnormal-orders",
    title: "B_TAbnormalOrder",
    connectionId: connection.id,
    database: "Inspharmacy",
    schema: "dbo",
    mode: "data",
    sql: "SELECT * FROM dbo.B_TAbnormalOrder",
    isExecuting: false,
    tableMeta: { tableName: "B_TAbnormalOrder", schema: "dbo", columns: [], primaryKeys: [] },
  });
  store.tabs = [tab];
  store.groups = [{ id: "main", tabIds: [tab.id], activeTabId: tab.id }];
  store.switchTab(tab.id);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const contentAreaRef = ref<InstanceType<typeof ContentArea> | null>(null);
  const app = createApp({
    setup: () => () =>
      h(ContentArea, {
        ref: contentAreaRef,
        activeTab: tab,
        activeConnection: connection,
        activeOutputView: "result",
        executableSql: "",
        formatSqlRequest: null,
        compressSqlRequest: null,
        selectedSql: "",
        cursorPos: 0,
        blockDangerousRedisCommands: false,
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mounted.push({ app, host });
  await nextTick();
  return { host, store, tab, contentAreaRef };
}

describe("table data header navigation", () => {
  it("delegates openTableStructureEditor to the data grid for active table data tabs", async () => {
    const { contentAreaRef, tab } = await mountDataTab();
    tab.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 };
    await vi.waitFor(() => expect(contentAreaRef.value?.openTableStructureEditor()).toBe(true));
    expect(mocks.openTableStructureEditor).toHaveBeenCalledWith("columns");

    tab.mode = "query";
    await nextTick();
    expect(contentAreaRef.value?.openTableStructureEditor()).toBe(false);
  });

  it("opens the columns editor from the header beside the table controls", async () => {
    const { host, tab } = await mountDataTab();
    tab.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 };
    await vi.waitFor(() => expect(host.querySelector("[data-edit-table-structure]")).not.toBeNull());
    const button = host.querySelector<HTMLButtonElement>("[data-edit-table-structure]")!;
    expect(button.closest("[data-grid-root]")).toBeNull();
    button.click();
    expect(mocks.openTableStructureEditor).toHaveBeenCalledWith("columns");
  });

  it.each([false, true])("opens the connection browser, reusing an existing tab: %s", async (alreadyOpen) => {
    const { host, store, tab } = await mountDataTab();
    const existingId = alreadyOpen ? store.openDatabaseBrowser(connection.id) : undefined;
    store.openDatabaseBrowser("other-connection");
    store.switchTab(tab.id);

    const button = host.querySelector<HTMLButtonElement>("button[data-data-header-connection]")!;
    expect(button.textContent?.trim()).toBe(connection.name);
    button.click();

    const targets = store.tabs.filter((item) => item.mode === "databases" && item.connectionId === connection.id);
    expect(targets).toHaveLength(1);
    expect(store.activeTabId).toBe(existingId ?? targets[0]!.id);
    expect(store.tabs).toContainEqual(tab);
    store.switchTab(tab.id);
    button.click();
    expect(store.activeTabId).toBe(targets[0]!.id);
    expect(store.tabs.filter((item) => item.mode === "databases")).toHaveLength(2);
  });

  it.each([false, true])("opens the schema object browser, reusing an existing tab: %s", async (alreadyOpen) => {
    const { host, store, tab } = await mountDataTab();
    const existingId = alreadyOpen ? store.openObjectBrowser(connection.id, tab.database, "dbo") : undefined;
    store.openObjectBrowser("other-connection", tab.database, "dbo");
    store.openObjectBrowser(connection.id, "other-database", "dbo");
    store.openObjectBrowser(connection.id, tab.database, "other-schema");
    store.switchTab(tab.id);

    const button = host.querySelector<HTMLButtonElement>("button[data-data-header-database]")!;
    expect(button.textContent?.trim()).toBe("dbo@Inspharmacy");
    button.click();

    const target = store.tabs.find((item) => item.id === store.activeTabId)!;
    expect(target).toMatchObject({ mode: "objects", connectionId: connection.id, database: tab.database, objectBrowser: { schema: "dbo" } });
    if (existingId) expect(target.id).toBe(existingId);
    expect(store.tabs.filter((item) => item.mode === "objects")).toHaveLength(4);
    store.switchTab(tab.id);
    button.click();
    expect(store.activeTabId).toBe(target.id);
    expect(store.tabs.filter((item) => item.mode === "objects")).toHaveLength(4);
  });

  it("preserves catalog scope and focuses an existing browser in another group", async () => {
    const { host, store, tab } = await mountDataTab();
    tab.tableMeta!.catalog = "external-catalog";
    const targetId = store.openObjectBrowser(connection.id, tab.database, "dbo", "external-catalog");
    expect(store.splitTabRight(targetId)).toBe(true);
    store.openObjectBrowser(connection.id, tab.database, "dbo", "other-catalog");
    store.switchTab(tab.id);
    await nextTick();

    host.querySelector<HTMLButtonElement>("button[data-data-header-database]")!.click();

    expect(store.activeTabId).toBe(targetId);
    expect(store.groups.find((group) => group.id === store.focusedGroupId)?.activeTabId).toBe(targetId);
    expect(store.tabs.filter((item) => item.mode === "objects")).toHaveLength(2);
  });
});
