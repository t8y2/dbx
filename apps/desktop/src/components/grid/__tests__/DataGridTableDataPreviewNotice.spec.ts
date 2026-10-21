// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";
import { localDayKey, TABLE_DATA_PREVIEW_NOTICE_MUTED_DAY_KEY } from "@/lib/dataGrid/tableDataPreviewNotice";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    buildTableSelectSql: vi.fn(async ({ tableName }: { tableName: string }) => `SELECT * FROM ${tableName}`),
    executeMulti: vi.fn().mockResolvedValue([]),
    cancelQuery: vi.fn().mockResolvedValue(undefined),
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
      renderedColumnWidths: ref([120, 180]),
      totalWidth: ref(300),
      columnVars: ref({ "--total-w": "300px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function previewResult(): QueryResult {
  return {
    columns: ["id", "payload"],
    rows: [[1, "preview"]],
    affected_rows: 0,
    execution_time_ms: 0,
    large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 4096 }],
  };
}

function mountGrid(result: QueryResult) {
  const resultRef = shallowRef(markRaw(result));
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "canvas" });

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
                connectionId: "conn-1",
                database: "db1",
                context: "table-data",
                tableMeta: {
                  tableName: "events",
                  columns: [
                    { name: "id", data_type: "int" },
                    { name: "payload", data_type: "text" },
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
  // Mount in canvas mode for the column-width dependencies, then exercise the DOM grid.
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  mountedApps.push({ app, host });
  return {
    host,
    async setResult(next: QueryResult) {
      resultRef.value = markRaw(next);
      await nextTick();
    },
  };
}

function settleGrid() {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

function previewNotice(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-grid-preview-notice]");
}

function buttonWithText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("DataGrid large table preview notice snooze", () => {
  it("shows the snooze action on the large table preview notice", async () => {
    const { host } = mountGrid(previewResult());
    await settleGrid();

    expect(previewNotice(host)).not.toBeNull();
    expect(previewNotice(host)?.textContent).toContain(i18n.global.t("grid.tableDataPreviewNotice"));
    expect(buttonWithText(host, i18n.global.t("grid.tableDataPreviewMuteToday")).textContent).toBe(i18n.global.t("grid.tableDataPreviewMuteToday"));
  });

  it("keeps the notice muted after the next result in the same session", async () => {
    const { host, setResult } = mountGrid(previewResult());
    await settleGrid();

    buttonWithText(host, i18n.global.t("grid.tableDataPreviewMuteToday")).click();
    await nextTick();
    expect(previewNotice(host)).toBeNull();
    expect(window.localStorage.getItem(TABLE_DATA_PREVIEW_NOTICE_MUTED_DAY_KEY)).toBe(localDayKey());

    await setResult(previewResult());
    await settleGrid();
    expect(previewNotice(host)).toBeNull();
  });

  it("hides the notice in grids kept alive in other tabs", async () => {
    const first = mountGrid(previewResult());
    const second = mountGrid(previewResult());
    await settleGrid();
    expect(previewNotice(first.host)).not.toBeNull();
    expect(previewNotice(second.host)).not.toBeNull();

    buttonWithText(first.host, i18n.global.t("grid.tableDataPreviewMuteToday")).click();
    await settleGrid();

    expect(previewNotice(first.host)).toBeNull();
    expect(previewNotice(second.host)).toBeNull();
  });

  it("shows the notice again when the stored snooze is from another day", async () => {
    window.localStorage.setItem(TABLE_DATA_PREVIEW_NOTICE_MUTED_DAY_KEY, "2000-01-01");
    const { host } = mountGrid(previewResult());
    await settleGrid();

    expect(previewNotice(host)).not.toBeNull();
  });

  it("keeps the close button scoped to the current result", async () => {
    const { host } = mountGrid(previewResult());
    await settleGrid();

    host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("grid.tableDataPreviewDismiss")}"]`)!.click();
    await nextTick();

    expect(previewNotice(host)).toBeNull();
    expect(window.localStorage.getItem(TABLE_DATA_PREVIEW_NOTICE_MUTED_DAY_KEY)).toBeNull();
  });
});
