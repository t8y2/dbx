// @vitest-environment happy-dom
import { createApp, defineComponent, h, markRaw, nextTick, ref, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn().mockResolvedValue({ statements: ["UPDATE aaaa SET name='9667' WHERE id=503"], rollbackStatements: [] }),
  execute: vi.fn().mockResolvedValue([]),
  toast: vi.fn(),
  executeQuery: vi.fn().mockResolvedValue({ columns: ["id", "test", "name"], rows: [[503, "50001", "9667"]], affected_rows: 1, execution_time_ms: 0 }),
  executeMulti: vi.fn().mockResolvedValue([{ columns: ["id", "test", "name"], rows: [[503, "50001", "9667"]], affected_rows: 1, execution_time_ms: 0 }]),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  prepareDataGridSave: mocks.prepare,
  executeBatch: mocks.execute,
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
  getTablePartitionStatus: vi.fn().mockResolvedValue(null),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getTableComment: vi.fn().mockResolvedValue(null),
  buildDataGridContextFilterCondition: vi.fn(async ({ columnName, value }: any) => `\`${columnName}\` = ${JSON.stringify(value)}`),
  buildTableSelectSql: vi.fn(async () => "SELECT * FROM aaaa WHERE id = 503"),
  executeQuery: mocks.executeQuery,
  executeMulti: mocks.executeMulti,
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      renderedColumnWidths: ref([120, 120, 120]),
      totalWidth: ref(360),
      columnVars: ref({ "--total-w": "360px" }),
      getIsResizing: () => false,
    }),
  };
});

import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { TooltipProvider } from "@/components/ui/tooltip";

const RecycleScroller = defineComponent({
  props: {
    items: {
      type: Array as PropType<unknown[]>,
      default: () => [],
    },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "div",
        attrs,
        props.items.map((item) => slots.default?.({ item })),
      );
  },
});

describe("DataGrid search cell edit retention (#12854)", () => {
  it("retains search filter results after editing a cell on a paginated table", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const settingsStore = useSettingsStore();
    settingsStore.updateEditorSettings({
      dataGridRenderMode: "canvas",
      dataGridSearchMode: "filter",
    });

    // Table with rows exceeding default (100)
    const rows: any[][] = [];
    for (let i = 0; i < 100; i++) {
      const id = 501 + i;
      rows.push([id, id === 503 ? "50001" : `val_${id}`, `name_${id}`]);
    }

    const result = markRaw<QueryResult>({
      columns: ["id", "test", "name"],
      rows,
      affected_rows: 0,
      execution_time_ms: 0,
      page_has_more: true,
      has_more: true,
    });

    const gridResult = ref(result);
    const host = document.createElement("div");
    document.body.append(host);
    const gridRef = ref<any>();

    const emittedReload: any[] = [];
    const Root = defineComponent({
      setup() {
        return () =>
          h(
            TooltipProvider,
            { delayDuration: 0 },
            {
              default: () =>
                h(DataGrid, {
                  ref: gridRef,
                  result: gridResult.value,
                  databaseType: "mysql",
                  context: "table-data",
                  editable: true,
                  connectionId: "conn-1",
                  database: "testdb",
                  pageOffset: 500,
                  pageLimit: 100,
                  totalRowCount: 1000,
                  onExecuteSql: vi.fn().mockResolvedValue({ affected_rows: 1, columns: [], rows: [] }),
                  onReload: (...args: any[]) => emittedReload.push(args),
                  tableMeta: {
                    tableName: "aaaa",
                    columns: [
                      { name: "id", data_type: "int", nullable: false },
                      { name: "test", data_type: "varchar", nullable: true },
                      { name: "name", data_type: "varchar", nullable: true },
                    ],
                    primaryKeys: ["id"],
                  },
                }),
            },
          );
      },
    });

    const app = createApp(Root);
    app.component("RecycleScroller", RecycleScroller);
    app.use(pinia);
    app.use(i18n);
    app.mount(host);

    await nextTick();
    await new Promise((r) => setTimeout(r, 100));

    // Open search and search for 50001 in column B
    gridRef.value?.focusSearch();
    await nextTick();

    const searchInput = host.querySelector<HTMLInputElement>("input[type='search']");
    expect(searchInput).toBeTruthy();
    if (searchInput) {
      searchInput.value = "50001";
      searchInput.dispatchEvent(new Event("input"));
    }

    // Wait for search debounce
    await new Promise((r) => setTimeout(r, 300));
    await nextTick();

    expect(gridRef.value?.displayItems).toHaveLength(1);
    expect(gridRef.value?.displayItems[0]?.data).toEqual([503, "50001", "name_503"]);

    // Select and edit column C ("name")
    const root = host.querySelector<HTMLElement>("[data-grid-root]")!;
    gridRef.value?.selectSingleCell(0, 2);
    await new Promise((r) => setTimeout(r, 50));
    await nextTick();

    const enterEvent = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
    root.dispatchEvent(enterEvent);
    await nextTick();
    await new Promise((r) => setTimeout(r, 50));

    const cellInput = host.querySelector<HTMLInputElement>("input.cell-edit-input, textarea.cell-edit-input");
    expect(cellInput).toBeTruthy();

    if (cellInput) {
      cellInput.value = "9667";
      cellInput.dispatchEvent(new Event("input"));
      cellInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      cellInput.dispatchEvent(new Event("blur"));
    }
    await nextTick();
    await new Promise((r) => setTimeout(r, 200));
    await nextTick();

    // Verify cell edit is reflected while search filter results are preserved
    expect(gridRef.value?.displayItems).toHaveLength(1);
    expect(gridRef.value?.displayItems[0]?.data).toEqual([503, "50001", "9667"]);
    const searchSpan = host.querySelector("[data-grid-search-bar]");
    expect(searchSpan?.textContent).toContain("1/1");

    // Commit changes to save
    await gridRef.value?.onToolbarCommit();
    await nextTick();

    // In-place refresh updates row in place without full reload, preserving search filter results
    expect(emittedReload).toEqual([]);
    expect(gridRef.value?.displayItems).toHaveLength(1);
    expect(gridRef.value?.displayItems[0]?.data).toEqual([503, "50001", "9667"]);
    expect(host.querySelector("[data-grid-search-bar]")?.textContent).toContain("1/1");
    expect(host.querySelector<HTMLInputElement>("input[type='search']")?.value).toBe("50001");

    app.unmount();
    host.remove();
  });
});
