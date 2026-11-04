// @vitest-environment happy-dom

import { createApp, h, markRaw, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/stores/settingsStore";
import type { DatabaseType, QueryResult } from "@/types/database";
import DataGrid from "../DataGrid.vue";

const mocks = vi.hoisted(() => ({ copy: vi.fn().mockResolvedValue(undefined), buildSelect: vi.fn() }));
vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/common/clipboard")>()),
  copyToClipboard: mocks.copy,
}));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
  buildTableSelectSql: mocks.buildSelect,
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
  const state = reactive({ result: result(), loading: false, sql: "SELECT * FROM orders;", pageSql: "SELECT * FROM orders LIMIT 100;", initialWhereInput: "status = 999", initialOrderByInput: "id ASC", onExecuteSql: vi.fn() as (() => void) | undefined });
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
  mocks.buildSelect.mockReset();
});

describe("quick-query SQL copy", () => {
  function footerCopy(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t("grid.copyQuerySql")}"]`);
  }

  const previewCases = [
    { databaseType: "mysql" as const, sql: "SELECT id, LEFT(body, 4097) AS body, CONCAT('T:4096:', LENGTH(body)) AS __DBX_LARGE_VALUE_BYTES_T_1 FROM orders WHERE status = 4 ORDER BY id DESC LIMIT 100 OFFSET 100;" },
    { databaseType: "postgres" as const, sql: "SELECT id, left(body, 4097) AS body, 'T:4096' AS \"__DBX_LARGE_VALUE_BYTES_T_1\" FROM orders WHERE status = 4 ORDER BY id DESC LIMIT 100 OFFSET 100;" },
    {
      databaseType: "oracle" as const,
      sql: 'SELECT "ID", "BODY", "__DBX_LARGE_VALUE_BYTES_T_1" FROM (SELECT dbx_inner.*, ROWNUM AS "__dbx_row_num" FROM (SELECT "ID", DBMS_LOB.SUBSTR("BODY", 1000, 1) AS "BODY", \'T:999:\' || DBMS_LOB.GETLENGTH("BODY") AS "__DBX_LARGE_VALUE_BYTES_T_1" FROM "orders" WHERE status = 4 ORDER BY id DESC) dbx_inner WHERE ROWNUM <= 200) WHERE "__dbx_row_num" > 100',
    },
  ];

  it.each(previewCases)("shares rebuilt $databaseType preview SQL between the toolbar and footer", async ({ databaseType, sql }) => {
    const expectedSql = databaseType === "oracle" ? 'SELECT * FROM (SELECT dbx_inner.*, ROWNUM AS "__dbx_row_num" FROM (SELECT * FROM "orders" WHERE status = 4 ORDER BY id DESC) dbx_inner WHERE ROWNUM <= 200) WHERE "__dbx_row_num" > 100' : PAGE_SQL;
    mocks.buildSelect.mockResolvedValue(expectedSql);
    const { button, host, state, errors } = mountGrid(databaseType, { showStatusSql: true });
    state.result = result({ sqlPage: { sql, executedSql: sql, limit: 100, offset: 100 } });
    await settle();
    expect(mocks.buildSelect).toHaveBeenLastCalledWith(expect.objectContaining({ whereInput: "status = 4", orderBy: "id DESC", limit: 100, offset: 100 }));
    expect(mocks.buildSelect.mock.lastCall?.[0]).not.toHaveProperty("largeValuePreviewSize");
    expect(mocks.buildSelect.mock.lastCall?.[0]).not.toHaveProperty("columnTypes");
    button().click();
    footerCopy(host)!.click();
    await settle();
    expect(mocks.copy.mock.calls.slice(-2).map((call) => call[0])).toEqual([expectedSql, expectedSql]);
    expect(host.querySelector("[data-result-sql]")?.textContent).toContain(expectedSql);
    expect(mocks.copy.mock.calls.every((call) => !/__DBX_LARGE_VALUE_BYTES_|LEFT\(|SUBSTR\(/i.test(call[0]))).toBe(true);

    const builds = mocks.buildSelect.mock.calls.length;
    for (const input of host.querySelectorAll<HTMLTextAreaElement>("textarea")) {
      input.value = "not_yet_executed";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle();
    button().click();
    footerCopy(host)!.click();
    await settle();
    expect(mocks.buildSelect).toHaveBeenCalledTimes(builds);
    expect(mocks.copy.mock.calls.slice(-2).map((call) => call[0])).toEqual([expectedSql, expectedSql]);
    expect(errors).toEqual([]);
  });

  it("uses executed conditions when rebuilding database-qualified SQL", async () => {
    const qualified = "SELECT * FROM `app`.`orders` WHERE status = 4 ORDER BY id DESC LIMIT 100 OFFSET 100;";
    mocks.buildSelect.mockResolvedValue(qualified);
    const { settings, button, host, errors } = mountGrid("mysql", { showStatusSql: true });
    settings.updateEditorSettings({ generateSqlIncludeDatabaseName: true });
    await settle();
    expect(mocks.buildSelect).toHaveBeenLastCalledWith(expect.objectContaining({ includeDatabaseName: true, whereInput: "status = 4", orderBy: "id DESC", limit: 100, offset: 100 }));
    button().click();
    footerCopy(host)!.click();
    await settle();
    expect(mocks.copy.mock.calls.slice(-2).map((call) => call[0])).toEqual([qualified, qualified]);
    expect(errors).toEqual([]);
  });

  it("never exposes an old page or a failed preview rebuild, and ignores late responses", async () => {
    const pending: Array<{ resolve: (sql: string) => void; reject: (error: Error) => void }> = [];
    mocks.buildSelect.mockImplementation(
      () =>
        new Promise<string>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const { button, state, host, errors } = mountGrid("mysql", { showStatusSql: true });
    await settle();
    const preview = previewCases[0].sql;
    state.result = result({ sqlPage: { sql: preview, limit: 100, offset: 100 } });
    await settle();
    expect(button().disabled).toBe(true);
    expect(footerCopy(host)).toBeNull();
    button().click();
    footerCopy(host)?.click();
    expect(mocks.copy).not.toHaveBeenCalled();
    state.result = result({ sqlPage: { sql: preview.replace("status = 4", "status = 5"), limit: 100, offset: 100 } });
    await settle();
    const latestSql = PAGE_SQL.replace("status = 4", "status = 5");
    pending[1]!.resolve(latestSql);
    await settle();
    pending[0]!.resolve(PAGE_SQL);
    await settle();
    button().click();
    footerCopy(host)!.click();
    await settle();
    expect(mocks.copy.mock.calls.slice(-2).map((call) => call[0])).toEqual([latestSql, latestSql]);

    state.result = result({ sqlPage: { sql: preview, limit: 100, offset: 100 } });
    await settle();
    pending[2]!.reject(new Error("SQL reconstruction unavailable"));
    await settle();
    expect(button().disabled).toBe(true);
    expect(footerCopy(host)).toBeNull();
    expect(mocks.copy).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });

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
