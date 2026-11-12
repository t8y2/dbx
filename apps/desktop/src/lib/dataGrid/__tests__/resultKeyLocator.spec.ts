import { describe, expect, it } from "vitest";
import { createResultKeyLocator } from "@/lib/dataGrid/resultKeyLocator";
import { appendIndexedResultCells, remapIndexedResultCells } from "@/lib/dataGrid/dataGridLargeValues";
import { stripPaginationRowNumber, trimQueryPageProbe } from "@/lib/query/queryPaginationResult";
import { buildTabResultSnapshot, decodeTabResultSnapshot, encodeTabResultSnapshot } from "@/lib/tabs/tabResultCache";
import type { QueryResult, QueryTab } from "@/types/database";

function sample(): QueryResult {
  return {
    columns: ["key", "part", "body"],
    column_types: ["VARCHAR", "INT", "TEXT"],
    rows: [
      ["缤纷", 1, "prefix A"],
      ["缤纷", 1, "prefix B"],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
    raw_key_cells: [
      { row_index: 0, column_index: 0, value: "çÍ·×" },
      { row_index: 0, column_index: 1, value: 1 },
      { row_index: 1, column_index: 0, value: "缤纷" },
      { row_index: 1, column_index: 1, value: 1 },
    ],
    large_value_cells: [{ row_index: 0, column_index: 2, original_bytes: 10000, pending_decode: true }],
  };
}

describe("original result key locators", () => {
  it("keeps original tuples distinct despite display collisions", () => {
    const locator = createResultKeyLocator(sample(), [0, 1], true, "unavailable");
    expect(locator.values(0)).toEqual(["çÍ·×", 1]);
    expect(locator.identity(0)).not.toBe(locator.identity(1));
  });

  it("preserves null and primitive types without delimiter collisions", () => {
    const result = sample();
    result.raw_key_cells = [
      { row_index: 0, column_index: 0, value: null },
      { row_index: 0, column_index: 1, value: 1 },
      { row_index: 1, column_index: 0, value: "null" },
      { row_index: 1, column_index: 1, value: "1" },
    ];
    const locator = createResultKeyLocator(result, [0, 1], true, "unavailable");
    expect(locator.values(0)).toEqual([null, 1]);
    expect(locator.identity(0)).not.toBe(locator.identity(1));
  });

  it("retains ordinary display-key behavior when compatibility mode is disabled", () => {
    const result = sample();
    result.raw_key_cells = undefined;
    expect(createResultKeyLocator(result, [0, 1], false, "unavailable").values(0)).toEqual(["缤纷", 1]);
    expect(() => createResultKeyLocator(result, [0, 1], true, "unavailable").values(0)).toThrow("unavailable");
  });

  it.each([[], [-1], [3], [0, 0]].map((indexes) => ({ indexes })))("rejects incomplete or ambiguous key indexes $indexes", ({ indexes }) => {
    expect(() => createResultKeyLocator(sample(), indexes, true, "unavailable").values(0)).toThrow("unavailable");
  });

  it("rebases appended metadata and drops lookahead keys before result matching", () => {
    const first = trimQueryPageProbe(sample(), 1);
    expect(first.raw_key_cells).toHaveLength(2);
    const appended = appendIndexedResultCells(first.raw_key_cells, sample().raw_key_cells, 1, 1);
    expect(appended?.map((cell) => cell.row_index)).toEqual([0, 0, 1, 1]);
    const remapped = remapIndexedResultCells(appended, [1, 0]);
    expect(remapped?.map((cell) => cell.row_index)).toEqual([1, 1, 0, 0]);
  });

  it("strips pagination-helper metadata without moving real keys", () => {
    const result = sample();
    result.columns.push("__page");
    result.rows.forEach((row) => row.push(99));
    result.raw_key_cells!.push({ row_index: 0, column_index: 3, value: 99 });
    const stripped = stripPaginationRowNumber(result, "__page");
    expect(stripped.raw_key_cells).toHaveLength(4);
    expect(createResultKeyLocator(stripped, [0, 1], true, "unavailable").values(0)).toEqual(["çÍ·×", 1]);
  });

  it("preserves pending state and original keys through actual snapshot construction and disk roundtrip", () => {
    const result = sample();
    const run = { id: "run", title: "Run", sequence: 1, sql: "SELECT * FROM example", createdAt: 1, result, results: [result], resultLocalSortOriginalRawKeyCells: result.raw_key_cells, resultLocalSortOriginalLargeValueCells: result.large_value_cells };
    const tab = { result, results: [result], resultRuns: [run], resultLocalSortOriginalRawKeyCells: result.raw_key_cells, resultLocalSortOriginalLargeValueCells: result.large_value_cells } as QueryTab;
    const snapshot = buildTabResultSnapshot(tab)!;
    const restored = decodeTabResultSnapshot(encodeTabResultSnapshot(snapshot));
    expect(snapshot.result!.raw_key_cells).not.toBe(result.raw_key_cells);
    expect(restored.resultLocalSortOriginalRawKeyCells).toEqual(result.raw_key_cells);
    expect(restored.resultLocalSortOriginalLargeValueCells).toEqual(result.large_value_cells);
    expect(restored.resultRuns![0]!.resultLocalSortOriginalRawKeyCells).toEqual(result.raw_key_cells);
    for (const restoredResult of [restored.result!, restored.results![0]!, restored.resultRuns![0]!.result!, restored.resultRuns![0]!.results![0]!]) {
      expect(restoredResult.raw_key_cells).toEqual(result.raw_key_cells);
      expect(restoredResult.large_value_cells).toEqual(result.large_value_cells);
      expect(createResultKeyLocator(restoredResult, [0, 1], true, "unavailable").values(0)).toEqual(["çÍ·×", 1]);
    }
  });
});
