// @vitest-environment happy-dom
import { createApp, defineComponent, h, ref, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearDataGridStructuredFilterStates, saveDataGridStructuredFilterState, loadDataGridStructuredFilterState } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";
const mocks = vi.hoisted(() => ({
  executeBatch: vi.fn(async () => []),
  getColumns: vi.fn(),
  buildDropTableChildObjectSql: vi.fn(async () => "ALTER TABLE users DROP COLUMN status"),
  buildDataGridContextFilterCondition: vi.fn(async ({ columnName, value }: { columnName: string; value: unknown }) => `${columnName} = ${value}`),
  loadEditorSettings: vi.fn(async () => ({})),
  saveEditorSettings: vi.fn(async () => undefined),
  saveOpenTabsState: vi.fn(async () => undefined),
  loadOpenTabsState: vi.fn(async () => null),
  closeClientConnectionSession: vi.fn(async () => undefined),
  closeQuerySession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/backend/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/backend/api")>()), ...mocks }));
vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      renderedColumnWidths: ref([120, 120]),
      totalWidth: ref(240),
      columnVars: ref({ "--total-w": "240px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
const mounted: Array<{ app: App; host: HTMLElement }> = [];
const col = (name: string) => ({ name, data_type: "int", is_nullable: false, is_primary_key: name === "id", extra: null, column_default: null });
const scope = (columns: string[]) => ["mysql-1", "app", "", "table-data", "", "users", columns.join("\0")].join("\u0001");
async function settle() {
  for (let i = 0; i < 8; i++) {
    await nextTick();
    await Promise.resolve();
  }
}
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  clearDataGridStructuredFilterStates();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
describe("DataGrid drop column cross-tab refresh", () => {
  it.each([false, true])("cleans another tab before refresh and reopening (mounted sibling: %s)", async (mountedSibling) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useSettingsStore().updateEditorSettings({ dataGridRenderMode: "canvas" });
    const query = useQueryStore();
    vi.spyOn(useConnectionStore(), "getConfig").mockReturnValue({ id: "mysql-1", name: "mysql", database: "app", db_type: "mysql" } as never);
    const firstId = query.createTab("mysql-1", "app", "users", "data");
    // createTab deduplicates identical titles; both tabs have the same tableMeta.
    const otherId = query.createTab("mysql-1", "app", "users copy", "data");
    expect(otherId).not.toBe(firstId);
    for (const id of [firstId, otherId]) {
      query.setTableMeta(id, { tableName: "users", database: "app", columns: [col("id"), col("status"), col("score")], primaryKeys: ["id"] });
      query.tabs.find((tab) => tab.id === id)!.result = { columns: ["id", "status", "score"], rows: [[1, 2, 3]], affected_rows: 0, execution_time_ms: 0 };
    }
    query.activateTab(firstId);
    const first = query.tabs.find((tab) => tab.id === firstId)!;
    const other = query.tabs.find((tab) => tab.id === otherId)!;
    other.whereInput = "status = 2 AND score = 3";
    other.orderByInput = "status DESC";
    other.result!.local_column_filters = { "1": ["2"], "2": ["3"] };
    saveDataGridStructuredFilterState(otherId, {
      scopeKey: scope(["id", "status", "score"]),
      manualWhereInput: "status = 2",
      appliedWhereInput: "score = 3",
      rules: [{ id: "score-rule", columnName: "score", mode: "equals", rawValue: "3", rawEndValue: "", conjunction: "AND" }],
      serverColumnFilters: {},
    });
    mocks.getColumns.mockResolvedValue([col("id"), col("score")]);
    const refresh = vi.spyOn(query, "refreshDataTab").mockImplementation(async (id) => {
      const tab = query.tabs.find((tab) => tab.id === id)!;
      expect(tab.whereInput).not.toContain("status");
      expect(tab.whereInput).toContain("score");
      expect(tab.orderByInput).toBeUndefined();
      expect(tab.result!.local_column_filters).toEqual({ "2": ["3"] });
      return true;
    });
    const grid = ref<{ selectSingleCell(row: number, column: number): void; onToolbarRefresh(): Promise<void> }>();
    const secondGrid = ref<{ onToolbarRefresh(): Promise<void> }>();
    const shownTab = ref(firstId);
    const onReload = vi.fn();
    const Root = defineComponent({
      setup: () => () => {
        const tabs = shownTab.value === firstId ? [first, ...(mountedSibling ? [other] : [])] : [other];
        return h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              tabs.map((tab, index) =>
                h(DataGrid, {
                  key: tab.id,
                  ref: index === 0 ? grid : secondGrid,
                  cacheKey: tab.id,
                  result: tab.result!,
                  databaseType: "mysql",
                  context: "table-data",
                  connectionId: tab.connectionId,
                  database: tab.database,
                  tableMeta: tab.tableMeta,
                  initialWhereInput: tab.whereInput,
                  initialOrderByInput: tab.orderByInput,
                  "onUpdate:whereInput": (value: string) => {
                    tab.whereInput = value;
                  },
                  "onUpdate:orderByInput": (value: string) => {
                    tab.orderByInput = value;
                  },
                  onReload,
                }),
              ),
          },
        );
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(Root);
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    mounted.push({ app, host });
    await settle();
    grid.value!.selectSingleCell(0, 1);
    await settle();
    const drop = host.querySelector<HTMLButtonElement>('[data-toolbar-action="deleteColumn"]')!;
    expect(drop.disabled).toBe(false);
    drop.click();
    await settle();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === i18n.global.t("grid.deleteColumn"))!;
    expect(confirm).toBeDefined();
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await vi.waitFor(() => expect(mocks.executeBatch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await settle();
    expect(loadDataGridStructuredFilterState(otherId, scope(["id", "score"]))?.rules.map((rule) => rule.columnName)).toEqual(["score"]);
    if (mountedSibling) {
      await secondGrid.value!.onToolbarRefresh();
      expect(onReload.mock.lastCall?.[2]).toContain("score");
      expect(onReload.mock.lastCall?.[2]).not.toContain("status");
    }
    shownTab.value = otherId;
    await settle();
    await grid.value!.onToolbarRefresh();
    expect(onReload.mock.lastCall?.[2]).toContain("score");
    expect(onReload.mock.lastCall?.[2]).not.toContain("status");
  });
});
