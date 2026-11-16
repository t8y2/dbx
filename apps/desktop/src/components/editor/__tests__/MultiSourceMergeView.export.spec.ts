// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import MultiSourceMergeView from "@/components/editor/MultiSourceMergeView.vue";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  exportQueryResultsXlsx: vi.fn().mockResolvedValue(undefined),
  exportQueryResultXlsx: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  exportQueryResultsXlsx: mocks.exportQueryResultsXlsx,
  exportQueryResultXlsx: mocks.exportQueryResultXlsx,
}));
// The web build assembles the workbook in the browser; the desktop build would
// first ask for a path, which is covered by the shared export code instead.
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

interface Sheet {
  sheetName: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}

function result(columns: string[], rows: (string | number | null)[][], affectedRows = rows.length): QueryResult {
  return { columns, rows, affected_rows: affectedRows, execution_time_ms: 1 };
}

function mountView(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(MultiSourceMergeView, props) });
  app.use(i18n);
  app.mount(host);
  return { host, app };
}

let mounted: { host: HTMLElement; app: App } | undefined;

beforeEach(() => {
  mocks.exportQueryResultsXlsx.mockClear();
  mocks.exportQueryResultXlsx.mockClear();
  mocks.toast.mockClear();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.host.remove();
  mounted = undefined;
});

function exportButton(selector: string): HTMLButtonElement {
  const button = mounted?.host.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing export button ${selector}`);
  return button;
}

describe("merged view export", () => {
  it.each(["page", "all"])("omits hidden middle columns from the display, summaries and %s export", async (scope) => {
    mounted = mountView({
      items: [
        { key: "a", label: "conn-a", status: "success", result: { ...result(["name", "__DBX_PK_0", "amount"], [["Alice", 987654, 10]]), hidden_column_indexes: [1] } },
        { key: "b", label: "conn-b", status: "success", result: result(["amount", "name"], [[20, "Bob"]]) },
      ],
      sql: "SELECT name, amount FROM t",
    });
    await nextTick();

    expect([...mounted.host.querySelectorAll("thead th")].map((cell) => cell.textContent?.trim())).toEqual([i18n.global.t("multiDbExecute.mergedSourceColumn"), "name", "amount"]);
    expect([...mounted.host.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()))).toEqual([
      ["conn-a", "Alice", "10"],
      ["conn-b", "Bob", "20"],
    ]);
    expect(mounted.host.querySelector("tfoot")?.textContent).toContain("30");
    expect(mounted.host.textContent).not.toContain("__DBX_PK_0");
    expect(mounted.host.textContent).not.toContain("987654");

    exportButton(`[data-merge-export-${scope}]`).click();
    await vi.waitFor(() => expect(mocks.exportQueryResultsXlsx).toHaveBeenCalledTimes(1));
    const sheet = (mocks.exportQueryResultsXlsx.mock.calls[0] as [string, Sheet[]])[1][0];
    expect(sheet?.columns).toEqual([i18n.global.t("multiDbExecute.mergedSourceColumn"), "name", "amount"]);
    expect(sheet?.rows).toEqual([
      ["conn-a", "Alice", 10],
      ["conn-b", "Bob", 20],
    ]);
  });

  it("exports every merged row plus a SQL sheet carrying the statement, the start time and the duration", async () => {
    mounted = mountView({
      items: [
        { key: "a", label: "conn-a", status: "success", result: result(["id", "amount"], [[1, 10]]) },
        { key: "b", label: "conn-b", status: "success", result: result(["id", "amount"], [[2, 20]]) },
      ],
      sql: "SELECT id, amount FROM t",
      durationMs: 1234,
      executedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    await nextTick();

    exportButton("[data-merge-export-all]").click();
    await vi.waitFor(() => expect(mocks.exportQueryResultsXlsx).toHaveBeenCalledTimes(1));

    const [outputPath, sheets, ...rest] = mocks.exportQueryResultsXlsx.mock.calls[0] as [string, Sheet[], boolean];
    expect(outputPath).toMatch(/^dbx-merged-result_all_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.xlsx$/);
    expect(rest).toEqual([true]);

    const [dataSheet, sqlSheet] = sheets;
    expect(dataSheet?.columns).toEqual([i18n.global.t("multiDbExecute.mergedSourceColumn"), "id", "amount"]);
    expect(dataSheet?.rows).toEqual([
      ["conn-a", 1, 10],
      ["conn-b", 2, 20],
    ]);
    // The statement and the batch timings travel in their own sheet.
    expect(sqlSheet?.sheetName).toBe("SQL");
    const sqlCells = (sqlSheet?.rows ?? []).flat().join("\n");
    expect(sqlCells).toContain("SELECT id, amount FROM t");
    expect(sqlCells).toContain(i18n.global.t("multiDbExecute.durationColumn"));
    expect(sqlCells).toContain("1.2 s");
    expect(String(sqlCells)).toMatch(/20\d\d-\d\d-\d\d/);
  });

  it("exports only the rows on screen for the current page", async () => {
    const rows = Array.from({ length: 1200 }, (_, index) => [index, index * 2]);
    mounted = mountView({
      items: [{ key: "a", label: "conn-a", status: "success", result: result(["id", "amount"], rows) }],
      sql: "SELECT id, amount FROM big",
      durationMs: 10,
    });
    await nextTick();

    exportButton("[data-merge-export-page]").click();
    await vi.waitFor(() => expect(mocks.exportQueryResultsXlsx).toHaveBeenCalledTimes(1));
    const pageSheet = (mocks.exportQueryResultsXlsx.mock.calls[0] as [string, Sheet[]])[1][0];
    expect(pageSheet?.rows).toHaveLength(1000);

    exportButton("[data-merge-export-all]").click();
    await vi.waitFor(() => expect(mocks.exportQueryResultsXlsx).toHaveBeenCalledTimes(2));
    const allSheet = (mocks.exportQueryResultsXlsx.mock.calls[1] as [string, Sheet[]])[1][0];
    expect(allSheet?.rows).toHaveLength(1200);
  });

  it("exports the per-target list when the batch returned no result set", async () => {
    mounted = mountView({
      items: [
        { key: "a", label: "conn-a", status: "success", durationMs: 12, result: result([], [], 3) },
        { key: "b", label: "conn-b", status: "failed", durationMs: 9, errorMessage: "syntax error" },
        { key: "c", label: "conn-c", status: "pending_commit", durationMs: 5, result: result([], [], 7), transaction: { canCommit: true } },
      ],
      transactional: true,
      sql: "UPDATE t SET amount = 0",
      durationMs: 40,
    });
    await nextTick();

    exportButton("[data-merge-export-all]").click();
    await vi.waitFor(() => expect(mocks.exportQueryResultsXlsx).toHaveBeenCalledTimes(1));

    const sheet = (mocks.exportQueryResultsXlsx.mock.calls[0] as [string, Sheet[]])[1][0];
    expect(sheet?.columns).toEqual([
      i18n.global.t("multiDbExecute.mergedSourceColumn"),
      i18n.global.t("multiDbExecute.statusColumn"),
      i18n.global.t("multiDbExecute.txnColumn"),
      i18n.global.t("multiDbExecute.affectedRowsColumn"),
      i18n.global.t("multiDbExecute.durationColumn"),
      i18n.global.t("multiDbExecute.errorColumn"),
    ]);
    expect(sheet?.rows.map((row) => row[0])).toEqual(["conn-a", "conn-b", "conn-c"]);
    // A statement that ran inside a transaction still reports its row count.
    expect(sheet?.rows[0]?.[3]).toBe(3);
    expect(sheet?.rows[2]?.[3]).toBe(7);
    expect(sheet?.rows[1]?.[3]).toBe("");
    expect(String(sheet?.rows[1]?.[5])).toBe("syntax error");
    expect(sheet?.rows[0]?.[2]).toBe(i18n.global.t("multiDbExecute.txnCommitted"));
    expect(sheet?.rows[2]?.[2]).toBe(i18n.global.t("multiDbExecute.txnOpen"));
  });

  it("keeps a single-sheet workbook when the batch carries no SQL context", async () => {
    mounted = mountView({
      items: [{ key: "a", label: "conn-a", status: "success", result: result(["id"], [[1]]) }],
    });
    await nextTick();

    exportButton("[data-merge-export-all]").click();
    await vi.waitFor(() => expect(mocks.exportQueryResultXlsx).toHaveBeenCalledTimes(1));

    const [outputPath, sheetName, columns, , , rows] = mocks.exportQueryResultXlsx.mock.calls[0] as [string, string, string[], string[], unknown, unknown[][]];
    expect(outputPath).toMatch(/\.xlsx$/);
    expect(sheetName).toBe(i18n.global.t("multiDbExecute.mergedSheetName"));
    expect(columns).toEqual([i18n.global.t("multiDbExecute.mergedSourceColumn"), "id"]);
    expect(rows).toEqual([["conn-a", 1]]);
    expect(mocks.exportQueryResultsXlsx).not.toHaveBeenCalled();
  });

  it("refuses to export an empty merged table", async () => {
    mounted = mountView({ items: [{ key: "a", label: "conn-a", status: "success", result: result(["id"], []) }] });
    await nextTick();

    exportButton("[data-merge-export-all]").click();
    await nextTick();

    expect(mocks.exportQueryResultsXlsx).not.toHaveBeenCalled();
    expect(mocks.exportQueryResultXlsx).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(i18n.global.t("multiDbExecute.mergedEmpty"), 3000);
  });
});
