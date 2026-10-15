// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

const backendMocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(async ({ tableName, orderBy }: { tableName: string; orderBy?: string }) => `SELECT * FROM ${tableName}${orderBy ? ` ORDER BY ${orderBy}` : ""}`),
  loadEditorSettings: vi.fn().mockResolvedValue({}),
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    buildTableSelectSql: backendMocks.buildTableSelectSql,
    loadEditorSettings: backendMocks.loadEditorSettings,
    saveEditorSettings: backendMocks.saveEditorSettings,
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

interface MountOptions {
  /** Rows currently loaded, already shifted by the page the user is on. */
  rows?: unknown[][];
  pageOffset?: number;
  pageLimit?: number;
  hasMore?: boolean;
}

function mountGrid(options: MountOptions = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "canvas" });

  const resultRef = shallowRef(
    markRaw<QueryResult>({
      columns: ["id", "name"],
      rows: options.rows ?? [
        [3, "C"],
        [4, "D"],
      ],
      affected_rows: 0,
      execution_time_ms: 0,
      has_more: options.hasMore ?? false,
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
                databaseType: "mysql",
                context: "table-data",
                connectionId: "conn-1",
                database: "db1",
                paginationEnabled: true,
                loadAllRowsEnabled: true,
                pageOffset: options.pageOffset ?? 0,
                pageLimit: options.pageLimit ?? 2,
                tableMeta: {
                  tableName: "items",
                  columns: [
                    { name: "id", data_type: "int" },
                    { name: "name", data_type: "varchar" },
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
  // Row numbers live in the DOM surface; canvas mode paints them instead.
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  mountedApps.push({ app, host });
  return { host, resultRef };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function rowNumberLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>(".data-grid-row-number")].map((node) => node.textContent?.trim() ?? "");
}

function loadAllButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Load all and go to the last row"]');
  if (!button) throw new Error("Load-all button not found");
  return button;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid row numbers after loading all rows", () => {
  it("numbers the loaded rows from the start of the result instead of the page the user came from", async () => {
    // The user is on page 2: the two loaded rows are result rows 3 and 4.
    const { host } = mountGrid({ pageOffset: 2, pageLimit: 2 });
    await settle();

    expect(rowNumberLabels(host)).toEqual(["3", "4"]);

    loadAllButton(host).click();
    await settle();

    // Once every row is loaded the grid shows the whole result, so numbering
    // restarts at 1 instead of keeping the page-2 offset.
    expect(rowNumberLabels(host)).toEqual(["1", "2"]);
  });
});
