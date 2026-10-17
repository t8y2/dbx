// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    buildTableSelectSql: vi.fn(async ({ tableName }: { tableName: string }) => `SELECT * FROM ${tableName}`),
    loadEditorSettings: vi.fn().mockResolvedValue({}),
    saveEditorSettings: vi.fn().mockResolvedValue(undefined),
  };
});

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
        return () =>
          h(
            "div",
            attrs,
            props.items.map((item) => slots.default?.({ item })),
          );
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
      renderedColumnWidths: ref([120]),
      totalWidth: ref(120),
      columnVars: ref({ "--total-w": "120px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function mountGrid() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "canvas" });

  const resultRef = shallowRef(
    markRaw<QueryResult>({
      columns: ["id", "flag"],
      rows: [
        [1, true],
        [2, false],
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
                result: resultRef.value,
                databaseType: "postgres",
                context: "table-data",
                connectionId: "conn-1",
                database: "db1",
                tableMeta: {
                  tableName: "items",
                  columns: [
                    { name: "id", data_type: "int" },
                    { name: "flag", data_type: "boolean" },
                  ],
                  primaryKeys: ["id"],
                },
                onExecuteSql: vi.fn().mockResolvedValue(undefined),
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  // Boolean cell text lives in the DOM surface; canvas mode paints it instead.
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  mountedApps.push({ app, host });
  return { host, settingsStore };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Text of the boolean ("flag") column for each rendered row. */
function flagColumnText(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-row-index] [data-visible-col-index="1"]')].map((node) => node.textContent?.trim() ?? "");
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid boolean cell text style", () => {
  it("shows TRUE/FALSE by default and 1/0 once the zero-one style is selected", async () => {
    const { host, settingsStore } = mountGrid();
    await settle();

    expect(flagColumnText(host)).toEqual(["TRUE", "FALSE"]);

    settingsStore.updateEditorSettings({ dataGridBooleanValueStyle: "zero-one" });
    await settle();

    expect(flagColumnText(host)).toEqual(["1", "0"]);
  });

  it("repaints the cached cell text when the style is toggled back", async () => {
    const { host, settingsStore } = mountGrid();
    await settle();

    settingsStore.updateEditorSettings({ dataGridBooleanValueStyle: "zero-one" });
    await settle();
    expect(flagColumnText(host)).toEqual(["1", "0"]);

    settingsStore.updateEditorSettings({ dataGridBooleanValueStyle: "true-false" });
    await settle();
    expect(flagColumnText(host)).toEqual(["TRUE", "FALSE"]);
  });
});
