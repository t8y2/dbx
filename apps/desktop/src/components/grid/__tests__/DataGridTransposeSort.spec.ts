// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    RecycleScroller: defineComponent({
      props: {
        items: {
          type: Array as PropType<unknown[]>,
          default: () => [],
        },
      },
      setup(props, { attrs, slots }) {
        return () => h("div", attrs, [slots.before?.(), props.items.map((item, index) => slots.default?.({ item, index }))]);
      },
    }),
  };
});

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
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function transposeFieldNames(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-grid-transpose-column-index]")].map((field) => field.textContent?.trim().split("\n")[0] ?? "");
}

function mountGrid() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom", dataGridMultiRowTranspose: true });

  const originalRows: QueryResult["rows"] = [
    ["b", "10"],
    ["a", null],
    ["c", "2"],
  ];
  const result = ref<QueryResult>(
    markRaw({
      columns: ["zeta", "alpha"],
      column_types: ["varchar", "bigint"],
      rows: originalRows,
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
                  tableName: "scores",
                  columns: [
                    { name: "zeta", data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
                    { name: "alpha", data_type: "bigint", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
                  ],
                  primaryKeys: ["zeta"],
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
});

describe("DataGrid transpose sorting", () => {
  it("sorts transpose field rows from the column-name header", async () => {
    const { host } = mountGrid();
    await settle();
    await openTranspose(host);
    expect(transposeFieldNames(host)).toEqual(["zeta", "alpha"]);
    host.querySelector<HTMLButtonElement>("[data-grid-transpose-column-sort]")!.click();
    await settle();
    expect(transposeFieldNames(host)).toEqual(["alpha", "zeta"]);
  });

  it("toggles descending field-name order from the same header button", async () => {
    const { host } = mountGrid();
    await settle();
    await openTranspose(host);
    const trigger = host.querySelector<HTMLButtonElement>("[data-grid-transpose-column-sort]");
    if (!trigger) throw new Error("Transpose column sort trigger not found");
    trigger.click();
    await settle();
    trigger.click();
    await settle();
    expect(transposeFieldNames(host)).toEqual(["zeta", "alpha"]);
  });
});
