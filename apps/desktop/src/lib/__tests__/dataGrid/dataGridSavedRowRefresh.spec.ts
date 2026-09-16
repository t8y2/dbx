import { describe, expect, it } from "vitest";
import { buildDataGridSavedRowRefreshPlan, dataGridSavedRowRefreshPatches } from "@/lib/dataGrid/dataGridSavedRowRefresh";

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
