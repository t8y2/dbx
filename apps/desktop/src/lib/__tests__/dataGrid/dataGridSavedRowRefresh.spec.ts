import { describe, expect, it, vi } from "vitest";
import { buildDataGridSavedRowRefreshPlan, dataGridSavedRowRefreshPatches, executeDataGridSavedRowRefreshQuery } from "@/lib/dataGrid/dataGridSavedRowRefresh";
import type { QueryResult } from "@/types/database";

function dirtyRows(...entries: Array<[number, Array<[number, string | number | boolean | null]>]>): Map<number, Map<number, string | number | boolean | null>> {
  return new Map(entries.map(([rowIndex, changes]) => [rowIndex, new Map(changes)]));
}

describe("dataGridSavedRowRefresh", () => {
  it("plans stable table-data row refreshes by primary key", () => {
    const result = buildDataGridSavedRowRefreshPlan({
      context: "table-data",
      infiniteScroll: false,
      filterActive: false,
      orderActive: false,
      columns: ["id", "name"],
      rows: [
        [1, "Ada"],
        [2, "Grace"],
      ],
      primaryKeys: ["id"],
      dirtyRows: dirtyRows([1, [[1, "Grace Hopper"]]]),
    });

    expect(result).toMatchObject({
      eligible: true,
      plan: {
        sourceIndexes: [1],
        identityColumns: ["id"],
        identityColumnIndexes: [0],
      },
    });
  });

  it.each([
    ["results context", { context: "results" as const }, "not-table-data"],
    ["infinite scroll", { infiniteScroll: true }, "infinite-scroll"],
    ["active filter", { filterActive: true }, "active-filter"],
    ["active order", { orderActive: true }, "active-order"],
    ["missing key", { primaryKeys: [] }, "missing-identity"],
    ["edited key", { dirtyRows: dirtyRows([0, [[0, 2]]]) }, "identity-edited"],
  ])("falls back for %s", (_label, overrides, reason) => {
    const result = buildDataGridSavedRowRefreshPlan({
      context: "table-data",
      infiniteScroll: false,
      filterActive: false,
      orderActive: false,
      columns: ["id", "name"],
      rows: [[1, "Ada"]],
      primaryKeys: ["id"],
      dirtyRows: dirtyRows([0, [[1, "Ada Lovelace"]]]),
      ...overrides,
    });

    expect(result).toEqual({ eligible: false, reason });
  });

  it("maps refreshed rows back to their original source indexes", () => {
    const planResult = buildDataGridSavedRowRefreshPlan({
      context: "table-data",
      infiniteScroll: false,
      filterActive: false,
      orderActive: false,
      columns: ["id", "name", "updated_at"],
      rows: [
        [1, "Ada", "old-1"],
        [2, "Grace", "old-2"],
      ],
      primaryKeys: ["id"],
      dirtyRows: dirtyRows([0, [[1, "Ada Lovelace"]]], [1, [[1, "Grace Hopper"]]]),
    });
    expect(planResult.eligible).toBe(true);
    if (!planResult.eligible) return;

    expect(
      dataGridSavedRowRefreshPatches(
        planResult.plan,
        ["id", "name", "updated_at"],
        undefined,
        ["updated_at", "name", "id"],
        [
          ["fresh-2", "Grace Hopper", 2],
          ["fresh-1", "Ada Lovelace", 1],
        ],
      ),
    ).toEqual([
      { sourceIndex: 0, refreshedRowIndex: 1, row: [1, "Ada Lovelace", "fresh-1"] },
      { sourceIndex: 1, refreshedRowIndex: 0, row: [2, "Grace Hopper", "fresh-2"] },
    ]);
  });

  it("rejects missing or duplicate refresh results", () => {
    const planResult = buildDataGridSavedRowRefreshPlan({
      context: "table-data",
      infiniteScroll: false,
      filterActive: false,
      orderActive: false,
      columns: ["id", "name"],
      rows: [[1, "Ada"]],
      primaryKeys: ["id"],
      dirtyRows: dirtyRows([0, [[1, "Ada Lovelace"]]]),
    });
    expect(planResult.eligible).toBe(true);
    if (!planResult.eligible) return;

    expect(dataGridSavedRowRefreshPatches(planResult.plan, ["id", "name"], undefined, ["id", "name"], [])).toBeNull();
    expect(
      dataGridSavedRowRefreshPatches(
        planResult.plan,
        ["id", "name"],
        undefined,
        ["id", "name"],
        [
          [1, "Ada"],
          [1, "Ada duplicate"],
        ],
      ),
    ).toBeNull();
  });
});

describe("executeDataGridSavedRowRefreshQuery", () => {
  const query = { connectionId: "c1", database: "cloudbook", schema: undefined, sql: "SELECT ...", rowLimit: 2, primaryKeys: ["id"] };

  function result(overrides: Partial<QueryResult> = {}): QueryResult {
    return { columns: ["id", "def_json"], rows: [[16, "{"]], affected_rows: 0, execution_time_ms: 1, ...overrides };
  }

  it("runs large-value preview SQL as a table-data preview so markers become large_value_cells", async () => {
    const preview = result({ large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 21814 }] });
    const runner = { executeQuery: vi.fn(), executeMulti: vi.fn().mockResolvedValue([preview]) };

    await expect(executeDataGridSavedRowRefreshQuery(runner, { ...query, largeValuePreview: true })).resolves.toBe(preview);
    expect(runner.executeQuery).not.toHaveBeenCalled();
    expect(runner.executeMulti).toHaveBeenCalledWith("c1", "cloudbook", "SELECT ...", undefined, undefined, { maxRows: 2, fetchSize: 2, pageSize: 2, resultKeyColumns: ["id"], tableDataPreview: true });
  });

  it("keeps the plain query path when no preview columns were requested", async () => {
    const plain = result();
    const runner = { executeQuery: vi.fn().mockResolvedValue(plain), executeMulti: vi.fn() };

    await expect(executeDataGridSavedRowRefreshQuery(runner, { ...query, largeValuePreview: false })).resolves.toBe(plain);
    expect(runner.executeMulti).not.toHaveBeenCalled();
    expect(runner.executeQuery).toHaveBeenCalledWith("c1", "cloudbook", "SELECT ...", undefined, undefined, { maxRows: 2, fetchSize: 2, pageSize: 2 });
  });

  it("returns null for a failed or empty preview execution so the grid reloads instead", async () => {
    const failing = { executeQuery: vi.fn(), executeMulti: vi.fn().mockResolvedValue([result({ execution_error: true })]) };
    const empty = { executeQuery: vi.fn(), executeMulti: vi.fn().mockResolvedValue([]) };

    await expect(executeDataGridSavedRowRefreshQuery(failing, { ...query, largeValuePreview: true })).resolves.toBeNull();
    await expect(executeDataGridSavedRowRefreshQuery(empty, { ...query, largeValuePreview: true })).resolves.toBeNull();
  });
});
