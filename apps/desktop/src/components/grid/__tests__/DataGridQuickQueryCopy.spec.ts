// @vitest-environment happy-dom

import { createApp, h, markRaw, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/stores/settingsStore";
import type { DatabaseType, QueryResult } from "@/types/database";
import DataGrid from "../DataGrid.vue";

const mocks = vi.hoisted(() => ({ copy: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/common/clipboard")>()),
  copyToClipboard: mocks.copy,
}));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
}));

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const PAGE_SQL = "SELECT * FROM orders WHERE status = 4 ORDER BY id DESC LIMIT 100 OFFSET 100;";
const PROBE_SQL = PAGE_SQL.replace("LIMIT 100", "LIMIT 101");

function result(overrides: Partial<QueryResult> = {}): QueryResult {
  return markRaw({
    columns: ["id", "status"],
    rows: [[1, 4]],
    affected_rows: 0,
    execution_time_ms: 1,
    sqlPage: { sql: PAGE_SQL, executedSql: PROBE_SQL, limit: 100, offset: 100, probe: true },
    ...overrides,
  });
}

function mountGrid(databaseType: DatabaseType = "mysql", options: { showStatusSql?: boolean } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.updateEditorSettings({ dataGridRenderMode: "canvas", showDataGridStatusSql: options.showStatusSql ?? false, generateSqlIncludeDatabaseName: false });
  const state = reactive({ result: result(), loading: false, sql: "SELECT * FROM orders;", pageSql: "SELECT * FROM orders LIMIT 100;", onExecuteSql: vi.fn() as (() => void) | undefined });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(
        TooltipProvider,
        {},
        {
          default: () =>
            h(DataGrid, {
              ...state,
              context: "table-data",
              databaseType,
              database: "app",
              connectionId: "copy-test",
              tableMeta: { tableName: "orders", columns: [], primaryKeys: [] },
            }),
        },
      ),
  });
  const errors: unknown[] = [];
  app.config.errorHandler = (error) => errors.push(error);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  return { host, state, settings, errors, button: () => host.querySelector<HTMLButtonElement>("[data-grid-copy-query-sql]")! };
}

async function settle() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.clearAllMocks();
});

describe("quick-query SQL copy", () => {
  it.each(["mysql", "postgres", "dameng", "sqlite"] as const)("copies the displayed %s query with filters, sorting and pagination", async (databaseType) => {
    const { host, button, state, errors } = mountGrid(databaseType);
    await settle();
    expect(host.querySelector("[data-result-sql]")).toBeNull();
    expect(button().disabled).toBe(false);
    expect(button().closest('[data-grid-topbar-row="filters"]')).not.toBeNull();
    button().click();
    await settle();
    expect(mocks.copy).toHaveBeenLastCalledWith(PAGE_SQL);
    expect(state.onExecuteSql).not.toHaveBeenCalled();

    // Editing either condition without executing must not change the copied SQL.
    for (const input of host.querySelectorAll<HTMLTextAreaElement>("textarea")) {
      input.value = "not_yet_executed";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle();
    button().click();
    await settle();
    expect(mocks.copy).toHaveBeenLastCalledWith(PAGE_SQL);
    expect(errors).toEqual([]);
  });

  it("follows the latest result page and still copies a successful empty result", async () => {
    const { button, state, errors } = mountGrid();
    await settle();
    const nextSql = "SELECT * FROM orders WHERE status = 5 ORDER BY id ASC LIMIT 100 OFFSET 200;";
    state.result = result({ rows: [], sqlPage: { sql: nextSql, limit: 100, offset: 200 } });
    await settle();
    button().click();
    await settle();
    expect(mocks.copy).toHaveBeenLastCalledWith(nextSql);
    expect(errors).toEqual([]);
  });

  it("disables copy while loading, on failure, and when SQL is unavailable", async () => {
    const { button, state, errors } = mountGrid();
    state.loading = true;
    await settle();
    expect(button().disabled).toBe(true);
    button().click();
    expect(mocks.copy).not.toHaveBeenCalled();
    state.loading = false;
    state.result = result({ execution_error: true });
    await settle();
    expect(button().disabled).toBe(true);
    state.result = result({ sqlPage: undefined });
    state.pageSql = "";
    state.sql = "";
    await settle();
    expect(button().disabled).toBe(true);
    expect(errors).toEqual([]);
  });

  it("uses page SQL for older results and hides the shortcut outside server query controls", async () => {
    const { host, state, button, errors } = mountGrid();
    state.result = result({ sqlPage: undefined });
    await settle();
    button().click();
    await settle();
    expect(mocks.copy).toHaveBeenLastCalledWith(state.pageSql);
    state.onExecuteSql = undefined;
    await settle();
    expect(host.querySelector("[data-grid-copy-query-sql]")).toBeNull();
    expect(errors).toEqual([]);
  });
});
