// @vitest-environment happy-dom
import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import MultiSourceMergeView from "@/components/editor/MultiSourceMergeView.vue";
import { buildXlsxWorkbook } from "@/lib/export/xlsxExport";
import { MULTI_SOURCE_MAX_ROWS_PER_SOURCE, mergeMultiSourceResults } from "@/lib/query/multiSourceResult";
import type { QueryResult } from "@/types/database";

function result(columns: string[], rows: (string | number | null)[][]): QueryResult {
  return { columns, rows, affected_rows: rows.length, execution_time_ms: 1 };
}

function mountView(items: Array<{ key: string; label: string; result?: QueryResult; status?: "success" | "failed" | "skipped" | "cancelled" | "not_executed" | "running" | "pending"; durationMs?: number; errorMessage?: string }>, props: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(MultiSourceMergeView, { items, ...props }) });
  app.use(i18n);
  app.mount(host);
  return { host, app };
}

let mounted: ReturnType<typeof mountView> | undefined;

afterEach(() => {
  mounted?.app.unmount();
  mounted?.host.remove();
  mounted = undefined;
});

describe("MultiSourceMergeView", () => {
  it("unions source columns, labels every row with its source and pads missing columns", async () => {
    mounted = mountView([
      { key: "a", label: "conn-a", result: result(["id", "amount"], [[1, 10]]) },
      { key: "b", label: "conn-b", result: result(["amount", "region"], [[20, "north"]]) },
    ]);
    await nextTick();

    const headers = [...mounted.host.querySelectorAll("thead th")].map((cell) => cell.textContent?.trim());
    expect(headers.slice(1)).toEqual(["id", "amount", "region"]);

    const rows = [...mounted.host.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.slice(1)).toEqual(["1", "10", ""]);
    expect(rows[1]?.slice(1)).toEqual(["", "20", "north"]);
    expect(rows[0]?.[0]).toContain("conn-a");
    expect(rows[1]?.[0]).toContain("conn-b");
  });

  it("sums only all-numeric columns in the footer", async () => {
    mounted = mountView([
      { key: "a", label: "conn-a", result: result(["id", "amount", "note"], [[1, 10, "x"]]) },
      { key: "b", label: "conn-b", result: result(["id", "amount", "note"], [[2, "n/a", "y"]]) },
    ]);
    await nextTick();

    const footer = [...(mounted.host.querySelector("tfoot")?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent?.trim());
    // First cell is the SUM label, then one cell per data column.
    expect(footer).toHaveLength(4);
    expect(footer[1]).toBe("3");
    // `amount` mixes 10 and "n/a", so its column is not a total.
    expect(footer[2]).toBe("");
    expect(footer[3]).toBe("");
  });

  it("reports the merged source count and row count", async () => {
    mounted = mountView([
      { key: "a", label: "conn-a", result: result(["id"], [[1]]) },
      { key: "b", label: "conn-b", result: result(["id"], [[2]]) },
    ]);
    await nextTick();

    const legend = mounted.host.querySelector("[data-multi-source-merge-view]")?.textContent ?? "";
    expect(legend).toContain("2");
  });

  it("states the per-source row cap and warns explicitly when a source hit it", async () => {
    const cappedRows = Array.from({ length: MULTI_SOURCE_MAX_ROWS_PER_SOURCE }, (_, index) => [index, index]);
    mounted = mountView([
      { key: "a", label: "conn-a", result: result(["id", "amount"], cappedRows) },
      { key: "b", label: "conn-b", result: result(["id", "amount"], [[1, 2]]) },
    ]);
    await nextTick();

    const legend = mounted.host.querySelector("[data-multi-source-merge-view]")?.textContent ?? "";
    // The cap is always stated, and reaching it is called out in amber.
    expect(legend).toContain(String(MULTI_SOURCE_MAX_ROWS_PER_SOURCE));
    expect(mounted.host.querySelector("[data-merge-source-cap-reached]")?.textContent).toContain(String(MULTI_SOURCE_MAX_ROWS_PER_SOURCE));
  });

  it("does not warn about the per-source cap while every source stays below it", async () => {
    mounted = mountView([
      { key: "a", label: "conn-a", result: result(["id"], [[1], [2]]) },
      { key: "b", label: "conn-b", result: result(["id"], [[3]]) },
    ]);
    await nextTick();

    expect(mounted.host.querySelector("[data-merge-source-cap-reached]")).toBeNull();
    expect(mounted.host.querySelector("[data-merge-truncated]")).toBeNull();
  });

  it("feeds the Excel writer a workbook-ready payload", () => {
    const merged = mergeMultiSourceResults(
      [
        { key: "a", label: "conn-a", result: result(["id", "amount", "note"], [[1, 10, "x"]]) },
        { key: "b", label: "conn-b", result: result(["amount"], [[2.5]]) },
      ],
      { sourceColumnLabel: "来源" },
    );

    // Same call shape the export action uses (no column types available).
    const workbook = buildXlsxWorkbook({
      sheetName: "合并结果",
      columns: merged.columns,
      columnTypes: merged.columns.map(() => ""),
      rows: merged.rows,
      numericColumnRightAlign: true,
      autoFilter: true,
    });

    expect(workbook.byteLength).toBeGreaterThan(0);
    // XLSX is a zip container; the local file header magic proves the writer
    // accepted the merged rows (nulls and mixed types included).
    expect(String.fromCharCode(...workbook.subarray(0, 2))).toBe("PK");
  });

  it("shows the executed statement and the batch duration in the header", async () => {
    mounted = mountView([{ key: "a", label: "conn-a", result: result(["id"], [[1]]) }], { sql: "SELECT id FROM sales", durationMs: 1250 });
    await nextTick();

    const header = mounted.host.querySelector("[data-multi-source-merge-view]")?.textContent ?? "";
    expect(header).toContain("SELECT id FROM sales");
    expect(header).toContain("1.3 s");
    expect(mounted.host.querySelector("[data-merge-sql]")?.getAttribute("title")).toBe("SELECT id FROM sales");
  });

  it("shows the local execution timestamp of the batch", async () => {
    const executedAt = new Date(2026, 8, 21, 14, 32, 5).getTime();
    mounted = mountView([{ key: "a", label: "conn-a", result: result(["id"], [[1]]) }], { executedAt });
    await nextTick();

    const chip = mounted.host.querySelector("[data-merge-executed-at]")?.textContent ?? "";
    expect(chip).toContain("2026-09-21 14:32:05");
    // Timezone stays explicit, like the app's other local timestamps.
    expect(chip).toMatch(/[+-]\d{2}:\d{2}/);
  });

  it("omits the SQL and duration chips when the host does not provide them", async () => {
    mounted = mountView([{ key: "a", label: "conn-a", result: result(["id"], [[1]]) }]);
    await nextTick();

    expect(mounted.host.querySelector("[data-merge-sql]")).toBeNull();
    expect(mounted.host.querySelector("[data-merge-duration]")).toBeNull();
    expect(mounted.host.querySelector("[data-merge-executed-at]")).toBeNull();
  });

  describe("write statements without a result set", () => {
    function writeItems() {
      return [
        {
          key: "a",
          label: "conn-a",
          status: "success" as const,
          durationMs: 41,
          result: { columns: [], rows: [], affected_rows: 12, execution_time_ms: 41 },
        },
        {
          key: "b",
          label: "conn-b",
          status: "failed" as const,
          durationMs: 17,
          errorMessage: "no such table: t_order",
          result: { columns: ["Error"], rows: [["no such table: t_order"]], affected_rows: 0, execution_time_ms: 17, execution_error: true as const },
        },
      ];
    }

    it("lists one row per target with status, affected rows and the error", async () => {
      mounted = mountView(writeItems());
      await nextTick();

      const table = mounted.host.querySelector("[data-merge-target-results]");
      expect(table).not.toBeNull();
      const rows = [...(table?.querySelectorAll("tbody tr") ?? [])].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.replace(/\s+/g, " ").trim()));
      expect(rows).toHaveLength(2);
      expect(rows[0]?.[0]).toBe("conn-a");
      expect(rows[0]?.[2]).toContain("12");
      expect(rows[1]?.[0]).toBe("conn-b");
      expect(rows[1]?.[2]).toBe("—");
      expect(rows[1]?.[4]).toContain("no such table");
    });

    it("summarizes the batch by targets and affected rows instead of read statistics", async () => {
      mounted = mountView(writeItems());
      await nextTick();

      expect(mounted.host.querySelector("[data-merge-write-summary]")?.textContent?.trim()).toBe(i18n.global.t("multiDbExecute.mergedWriteSummary", { targets: 2, rows: 12 }));
      // A write batch must not advertise the per-source read cap it never uses.
      expect(mounted.host.textContent).not.toContain(i18n.global.t("multiDbExecute.mergedSourceRowCap", { count: MULTI_SOURCE_MAX_ROWS_PER_SOURCE }));
      // The column already names the count, so the cell carries the bare number.
      const affected = [...(mounted.host.querySelectorAll("[data-merge-target-results] tbody tr") ?? [])].map((row) => [...row.querySelectorAll("td")][2]?.textContent?.trim());
      expect(affected).toEqual(["12", "—"]);
    });

    it("offers a re-run only for targets that did not succeed", async () => {
      const rerun: string[] = [];
      mounted = mountView(writeItems(), { onRerunTarget: (key: string) => rerun.push(key) });
      await nextTick();

      const buttons = [...mounted.host.querySelectorAll("[data-merge-rerun]")];
      expect(buttons).toHaveLength(1);
      (buttons[0] as HTMLButtonElement).click();
      await nextTick();
      expect(rerun).toEqual(["b"]);
    });

    it("blocks re-running while the batch is still busy", async () => {
      mounted = mountView(writeItems(), { rerunDisabled: true });
      await nextTick();

      const rerunButton = mounted.host.querySelector("[data-merge-rerun]") as HTMLButtonElement | null;
      expect(rerunButton?.disabled).toBe(true);
    });
  });
});
