// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { QueryResult } from "@/types/database";

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

const LONG_SQL = "SELECT TOP (200) A.*, (SELECT TOP 1 B.TransPortCode FROM listPortLocalCharge B WHERE B.portCode='CNTXG' AND B.create_by ='EXW' AND B.TransPortName='TEST' AND B.other='12345678901234567890') FROM A_listPortLocalCharge_DATA A ORDER BY CONVERT(INT, A.NO) ASC";

function pageResult(sql = LONG_SQL): QueryResult {
  return markRaw({
    columns: ["id", "code"],
    rows: Array.from({ length: 100 }, (_, i) => [i + 1, `code-${i + 1}`]),
    affected_rows: 100,
    execution_time_ms: 85,
    has_more: true,
    sqlPage: {
      sql,
      limit: 100,
      offset: 0,
    },
  });
}

function mountGrid(options: { showStatusSql?: boolean; countTotalRows?: () => Promise<number | undefined> } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    infiniteScroll: false,
    showDataGridStatusSql: options.showStatusSql !== false,
  });

  const state = reactive({
    result: pageResult(),
    pageOffset: 0,
    loading: false,
    totalRowCount: undefined as number | undefined,
    countSql: "SELECT COUNT(*) FROM A_listPortLocalCharge_DATA",
  });

  const onReload = vi.fn();
  const onPaginate = vi.fn();
  const countTotalRows = options.countTotalRows ?? vi.fn().mockResolvedValue(15000);

  const Root = defineComponent({
    setup: () => () =>
      h(
        TooltipProvider,
        { delayDuration: 0 },
        {
          default: () =>
            h(DataGrid, {
              ...state,
              pageLimit: 100,
              context: "table-data",
              databaseType: "mssql",
              connectionId: "test-conn",
              database: "test_db",
              tableMeta: { tableName: "A_listPortLocalCharge_DATA", schema: "dbo", columns: [], primaryKeys: [] },
              paginationEnabled: true,
              countTotalRows,
              onReload,
              onPaginate,
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
  mountedApps.push({ app, host });
  return { host, state, countTotalRows, settingsStore };
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid status bar SQL and total row count layout", () => {
  it("renders total row count with min-w-max and shrink-0 so it is not squeezed by long SQL", async () => {
    const { host } = mountGrid({ showStatusSql: true });
    await settle();

    // Check that status SQL is rendered
    const sqlButton = host.querySelector<HTMLButtonElement>("button[data-result-sql]");
    expect(sqlButton).not.toBeNull();
    expect(sqlButton?.textContent).toContain("SELECT TOP (200)");

    // Locate the first column containing row counts
    const statusCol1 = host.querySelector(".grid.grid-cols-\\[max-content_minmax\\(0\\,1fr\\)_max-content\\] > div:first-child");
    expect(statusCol1).not.toBeNull();
    expect(statusCol1?.className).toContain("min-w-max");
    expect(statusCol1?.className).toContain("shrink-0");
    expect(statusCol1?.className).not.toContain("min-w-0");
    expect(statusCol1?.className).not.toContain("overflow-hidden");

    // Row count and total count trigger must both be present in Col 1
    expect(statusCol1?.textContent).toContain("100");
    const countLabel = String(i18n.global.t("grid.calculateTotalRowsInline"));
    const countBtn = Array.from(statusCol1?.querySelectorAll("button") ?? []).find((btn) => btn.textContent?.trim() === countLabel);
    expect(countBtn).toBeDefined();

    // The status SQL middle container must have overflow-hidden to prevent spilling
    const sqlContainer = sqlButton?.closest(".justify-self-center");
    expect(sqlContainer).not.toBeNull();
    expect(sqlContainer?.className).toContain("overflow-hidden");
  });

  it("keeps total row count visible after calculating exact total even with very long SQL", async () => {
    const { host } = mountGrid({ showStatusSql: true });
    await settle();

    const statusCol1 = host.querySelector(".grid.grid-cols-\\[max-content_minmax\\(0\\,1fr\\)_max-content\\] > div:first-child");
    const countLabel = String(i18n.global.t("grid.calculateTotalRowsInline"));
    const countBtn = Array.from(statusCol1?.querySelectorAll("button") ?? []).find((btn) => btn.textContent?.trim() === countLabel);
    expect(countBtn).toBeDefined();

    countBtn?.click();
    await settle();

    // Now displayed total count should be rendered
    expect(statusCol1?.textContent).toContain("15000");

    // Status SQL should still be present alongside
    const sqlButton = host.querySelector<HTMLButtonElement>("button[data-result-sql]");
    expect(sqlButton).not.toBeNull();
  });

  it("hides status SQL and renders empty span when showDataGridStatusSql is false", async () => {
    const { host } = mountGrid({ showStatusSql: false });
    await settle();

    const sqlButton = host.querySelector("button[data-result-sql]");
    expect(sqlButton).toBeNull();

    // Row count in Col 1 is intact
    const statusCol1 = host.querySelector(".grid.grid-cols-\\[max-content_minmax\\(0\\,1fr\\)_max-content\\] > div:first-child");
    expect(statusCol1?.textContent).toContain("100");
  });
});
