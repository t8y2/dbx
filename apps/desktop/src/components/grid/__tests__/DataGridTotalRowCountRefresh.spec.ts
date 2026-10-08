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

function pageResult(): QueryResult {
  return markRaw({ columns: ["id"], rows: Array.from({ length: 100 }, (_, i) => [i + 1]), affected_rows: 100, execution_time_ms: 1, has_more: true });
}

function mountGrid(countTotalRows = vi.fn<() => Promise<number | undefined>>().mockResolvedValue(250)) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().updateEditorSettings({ dataGridRenderMode: "canvas", infiniteScroll: false });
  const state = reactive({ result: pageResult(), pageOffset: 0, loading: false, totalRowCount: undefined as number | undefined, countSql: "SELECT COUNT(*) FROM users WHERE active = 1" });
  const onReload = vi.fn(async () => {
    state.loading = true;
    await nextTick();
    state.result = pageResult();
    state.loading = false;
  });
  const onPaginate = vi.fn();
  const Root = defineComponent({
    setup: () => () =>
      h(
        TooltipProvider,
        { delayDuration: 0 },
        { default: () => h(DataGrid, { ...state, pageLimit: 100, context: "table-data", databaseType: "mysql", connectionId: "test", database: "db", tableMeta: { tableName: "users", schema: "db", columns: [], primaryKeys: [] }, paginationEnabled: true, countTotalRows, onReload, onPaginate }) },
      ),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mountedApps.push({ app, host });
  return { host, state, countTotalRows, onReload, onPaginate };
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

function clickButton(host: HTMLElement, label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
  if (!button) throw new Error(`Button missing: ${label}`);
  button.click();
}

function totalText(host: HTMLElement) {
  return host.textContent ?? "";
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

describe("DataGrid manual count freshness", () => {
  it("invalidates a manual count on refresh and allows counting the updated rows", async () => {
    const { host, countTotalRows, onReload } = mountGrid();
    await settle();
    clickButton(host, String(i18n.global.t("grid.calculateTotalRowsInline")));
    await settle();
    expect(totalText(host)).toContain("250");

    clickButton(host, String(i18n.global.t("grid.refresh")));
    await settle();
    expect(onReload).toHaveBeenCalledOnce();
    expect(totalText(host)).not.toContain("250");
    countTotalRows.mockResolvedValue(199);
    clickButton(host, String(i18n.global.t("grid.calculateTotalRowsInline")));
    await settle();
    expect(totalText(host)).toContain("199");
  });

  it("keeps the count while paging through the same result", async () => {
    const { host, state } = mountGrid();
    await settle();
    clickButton(host, String(i18n.global.t("grid.calculateTotalRowsInline")));
    await settle();
    state.pageOffset = 100;
    state.result = pageResult();
    await settle();
    expect(totalText(host)).toContain("250");
  });

  it("reconciles a stale exact total when a page lands beyond it (#10968)", async () => {
    const { host, state } = mountGrid();
    await settle();
    clickButton(host, String(i18n.global.t("grid.calculateTotalRowsInline")));
    await settle();
    expect(totalText(host)).toContain("250");

    // The COUNT said 250, but the served snapshot holds more: the counted last
    // page (offset 200, page size 100) comes back full, so row indexes reach
    // 300 — adopt the observed extent instead of showing rows past the total.
    state.pageOffset = 200;
    state.result = pageResult();
    await settle();
    expect(totalText(host)).toContain("300");
  });

  it("does not let an old manual count override a refreshed automatic count", async () => {
    let resolveCount!: (total: number) => void;
    const countTotalRows = vi.fn(() => new Promise<number>((resolve) => (resolveCount = resolve)));
    const { host, state } = mountGrid(countTotalRows);
    await settle();
    clickButton(host, String(i18n.global.t("grid.calculateTotalRowsInline")));
    await settle();
    clickButton(host, String(i18n.global.t("grid.refresh")));
    state.totalRowCount = 199;
    await settle();
    resolveCount(250);
    await settle();
    expect(totalText(host)).toContain("199");
    expect(totalText(host)).not.toContain("250");
  });

  it("discards a pending count after the query context changes", async () => {
    let resolveCount!: (total: number) => void;
    const { host, state } = mountGrid(vi.fn(() => new Promise<number>((resolve) => (resolveCount = resolve))));
    await settle();
    clickButton(host, String(i18n.global.t("grid.calculateTotalRowsInline")));
    await settle();
    state.countSql = "SELECT COUNT(*) FROM other_users";
    await settle();
    resolveCount(250);
    await settle();
    expect(totalText(host)).not.toContain("250");
  });

  it("does not navigate using a last-page count completed after refresh", async () => {
    let resolveCount!: (total: number) => void;
    const { host, onPaginate } = mountGrid(vi.fn(() => new Promise<number>((resolve) => (resolveCount = resolve))));
    await settle();
    const pageInput = host.querySelector<HTMLInputElement>(`input[aria-label="${i18n.global.t("grid.jumpToPage")}"]`)!;
    const lastPageButton = pageInput.nextElementSibling!.nextElementSibling as HTMLButtonElement;
    expect(lastPageButton.disabled).toBe(false);
    lastPageButton.click();
    await settle();
    clickButton(host, String(i18n.global.t("grid.refresh")));
    await settle();
    resolveCount(250);
    await settle();
    expect(onPaginate).not.toHaveBeenCalled();
    expect(totalText(host)).not.toContain("250");
  });
});
