// @vitest-environment happy-dom
//
// Regression test for #12128: clicking a cell in the transposed view must not
// yank the clicked field row to the top of the viewport. Cell clicks route
// through applyCellNavigation with block "nearest", so the transpose field
// scroll must ask the scroller for nearest alignment instead of the default
// start alignment.

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

const scrollToItem = vi.fn();

vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: {
      items: {
        type: Array as PropType<unknown[]>,
        default: () => [],
      },
    },
    setup(props, { attrs, slots, expose }) {
      expose({ scrollToItem });
      return () => h("div", attrs, [slots.before?.(), props.items.map((item, index) => slots.default?.({ item, index }))]);
    },
  }),
}));

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

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function mountGrid() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom", dataGridMultiRowTranspose: false });

  const result = ref<QueryResult>(
    markRaw({
      columns: ["id", "name", "notes"],
      column_types: ["int", "varchar", "varchar"],
      rows: [
        ["1", "Ada", "first"],
        ["2", "Grace", "second"],
        ["3", "Linus", "third"],
      ],
      affected_rows: 0,
      execution_time_ms: 0,
    }),
  );

  const host = document.createElement("div");
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(DataGrid, {
                result: result.value,
                databaseType: "mysql",
                context: "table-data",
                tableMeta: {
                  tableName: "people",
                  columns: [
                    { name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
                    { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
                    { name: "notes", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
                  ],
                  primaryKeys: ["id"],
                },
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mountedApps.push({ app, host });
  return { host };
}

async function openTranspose(host: HTMLElement) {
  const firstRowNumber = host.querySelector<HTMLElement>(".data-grid-row-number");
  if (!firstRowNumber) throw new Error("Row number not found");
  firstRowNumber.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  firstRowNumber.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0 }));
  await settle();
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  scrollToItem.mockClear();
});

describe("DataGrid transpose cell click scrolling", () => {
  it("asks for nearest alignment so the clicked field stays in place", async () => {
    const { host } = mountGrid();
    await settle();
    await openTranspose(host);

    const fieldRows = host.querySelectorAll<HTMLElement>(".data-grid-transpose-row");
    const secondFieldCell = fieldRows[1]?.querySelector<HTMLElement>("[data-grid-transpose-cell]");
    if (!secondFieldCell) throw new Error("Transpose cell not found");

    secondFieldCell.click();
    await settle();

    expect(scrollToItem).toHaveBeenLastCalledWith(1, { align: "nearest" });
  });
});
