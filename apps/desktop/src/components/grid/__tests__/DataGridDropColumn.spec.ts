// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
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
      hasUserSizedColumns: ref(false),
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
describe("DataGrid drop column availability", () => {
  it("does not expose column deletion in the table data view", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useSettingsStore().updateEditorSettings({ dataGridRenderMode: "canvas" });
    const query = useQueryStore();
    vi.spyOn(useConnectionStore(), "getConfig").mockReturnValue({ id: "mysql-1", name: "mysql", database: "app", db_type: "mysql" } as never);
    const tabId = query.createTab("mysql-1", "app", "users", "data");
    query.setTableMeta(tabId, { tableName: "users", database: "app", columns: [col("id"), col("status")], primaryKeys: ["id"] });
    const tab = query.tabs.find((candidate) => candidate.id === tabId)!;
    tab.result = { columns: ["id", "status"], rows: [[1, 2]], affected_rows: 0, execution_time_ms: 0 };
    query.activateTab(tabId);
    const onReload = vi.fn();
    const Root = defineComponent({
      setup: () => () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(DataGrid, {
                cacheKey: tabId,
                result: tab.result!,
                databaseType: "mysql",
                context: "table-data",
                connectionId: tab.connectionId,
                database: tab.database,
                tableMeta: tab.tableMeta,
                onReload,
              }),
          },
        ),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(Root);
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    mounted.push({ app, host });
    await settle();
    const header = host.querySelectorAll<HTMLElement>(".data-grid-header-cell")[1];
    expect(header).toBeDefined();
    header!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
    await settle();
    expect(document.querySelector("[data-dbx-context-menu]")).not.toBeNull();
    expect(host.querySelector('[data-toolbar-action="deleteColumn"]')).toBeNull();
    expect([...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].some((button) => button.textContent?.trim() === i18n.global.t("dangerDialog.title"))).toBe(false);
    expect([...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].some((button) => button.textContent?.trim() === i18n.global.t("grid.deleteColumn"))).toBe(false);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(mocks.buildDropTableChildObjectSql).not.toHaveBeenCalled();
  });
});
