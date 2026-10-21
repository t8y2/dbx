// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

interface CanvasDrawCall {
  pixelRatio?: number;
  width?: number;
  height?: number;
}

const drawCalls: CanvasDrawCall[] = [];

vi.mock("@/lib/dataGrid/canvasDataGridRenderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dataGrid/canvasDataGridRenderer")>();
  return {
    ...actual,
    drawCanvasDataGrid: vi.fn((options: any) => {
      drawCalls.push({
        pixelRatio: options.pixelRatio,
        width: options.width,
        height: options.height,
      });
      return actual.drawCanvasDataGrid(options);
    }),
  };
});

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
      columns: ["id", "val"],
      rows: [[1, "test"]],
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
                    { name: "val", data_type: "text" },
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
  mountedApps.push({ app, host });
  return { host, settingsStore };
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  drawCalls.length = 0;
});

describe("DataGrid canvas backing ratio under UI zoom", () => {
  it("does not multiply devicePixelRatio by uiScale again at 1.25x (prevents blur)", async () => {
    // Under Webview zoom factor 1.25 on 1x display, window.devicePixelRatio is 1.25
    Object.defineProperty(window, "devicePixelRatio", { value: 1.25, writable: true, configurable: true });

    const { settingsStore } = mountGrid();
    settingsStore.updateEditorSettings({ uiScale: 1.25 });
    window.dispatchEvent(new CustomEvent("dbx:ui-scale-applied", { detail: { scale: 1.25 } }));

    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(drawCalls.length).toBeGreaterThan(0);
    const lastDraw = drawCalls[drawCalls.length - 1];
    // It should be 1.25, NOT 1.25 * 1.25 = 1.5625
    expect(lastDraw?.pixelRatio).toBe(1.25);
  });

  it("does not multiply devicePixelRatio by uiScale again at 1.5x zoom (issue #12475)", async () => {
    // Under Webview zoom factor 1.5, window.devicePixelRatio is 1.5
    Object.defineProperty(window, "devicePixelRatio", { value: 1.5, writable: true, configurable: true });

    const { settingsStore } = mountGrid();
    settingsStore.updateEditorSettings({ uiScale: 1.5 });
    window.dispatchEvent(new CustomEvent("dbx:ui-scale-applied", { detail: { scale: 1.5 } }));

    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(drawCalls.length).toBeGreaterThan(0);
    const lastDraw = drawCalls[drawCalls.length - 1];
    // It should be 1.5, NOT 1.5 * 1.5 = 2.25
    expect(lastDraw?.pixelRatio).toBe(1.5);
  });

  it("keeps exact device pixel ratio on high-DPI display with zoom", async () => {
    // 2x Retina display with 1.25x zoom: window.devicePixelRatio is 2.5
    Object.defineProperty(window, "devicePixelRatio", { value: 2.5, writable: true, configurable: true });

    const { settingsStore } = mountGrid();
    settingsStore.updateEditorSettings({ uiScale: 1.25 });
    window.dispatchEvent(new CustomEvent("dbx:ui-scale-applied", { detail: { scale: 1.25 } }));

    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(drawCalls.length).toBeGreaterThan(0);
    const lastDraw = drawCalls[drawCalls.length - 1];
    // It should be 2.5, NOT 2.5 * 1.25 = 3.125
    expect(lastDraw?.pixelRatio).toBe(2.5);
  });
});
