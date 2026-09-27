import { describe, expect, it } from "vitest";
import { MULTI_SOURCE_MERGE_MAX_ROWS, isNumericSummaryCellValue, mergeMultiSourceResults, summarizeNumericColumns } from "@/lib/query/multiSourceResult";
import type { QueryResult } from "@/types/database";

function result(columns: string[], rows: (string | number | boolean | null)[][], overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    columns,
    rows,
    affected_rows: rows.length,
    execution_time_ms: 1,
    ...overrides,
  };
}

describe("mergeMultiSourceResults", () => {
  it("unions columns by name and injects the source column first", () => {
    const merged = mergeMultiSourceResults(
      [
        { key: "a", label: "conn-a / sales", result: result(["id", "amount"], [[1, 10]]) },
        { key: "b", label: "conn-b / sales", result: result(["amount", "region"], [[20, "north"]]) },
      ],
      { sourceColumnLabel: "Source" },
    );

    expect(merged.columns).toEqual(["Source", "id", "amount", "region"]);
    expect(merged.rows).toEqual([
      ["conn-a / sales", 1, 10, null],
      ["conn-b / sales", null, 20, "north"],
    ]);
    expect(merged.rowCount).toBe(2);
    expect(merged.truncated).toBe(false);
    expect(merged.skippedLabels).toEqual([]);
    expect(merged.sources).toEqual([
      { key: "a", label: "conn-a / sales", rowCount: 1, columnCount: 2 },
      { key: "b", label: "conn-b / sales", rowCount: 1, columnCount: 2 },
    ]);
  });

  it("keeps duplicate column names of one source as separate value streams", () => {
    const merged = mergeMultiSourceResults(
      [
        { key: "a", label: "a", result: result(["id", "id"], [[1, 2]]) },
        { key: "b", label: "b", result: result(["id"], [[9]]) },
      ],
      { sourceColumnLabel: "Source" },
    );

    expect(merged.columns).toEqual(["Source", "id", "id"]);
    expect(merged.rows).toEqual([
      ["a", 1, 2],
      ["b", 9, null],
    ]);
  });

  it("excludes hidden middle columns without shifting source values or numeric summaries", () => {
    const first = result(["name", "__DBX_PK_0", "amount", "region"], [["Alice", 17, 10, "north"]], { hidden_column_indexes: [1] });
    const second = result(["amount", "name", "__DBX_PK_0"], [[20, "Bob", 23]], { hidden_column_indexes: [2] });
    const merged = mergeMultiSourceResults(
      [
        { key: "a", label: "a", result: first },
        { key: "b", label: "b", result: second },
      ],
      { sourceColumnLabel: "Source" },
    );

    expect(merged.columns).toEqual(["Source", "name", "amount", "region"]);
    expect(merged.rows).toEqual([
      ["a", "Alice", 10, "north"],
      ["b", "Bob", 20, null],
    ]);
    expect(merged.summaries).toEqual([{ columnIndex: 2, column: "amount", sum: 30, count: 2 }]);
    expect(merged.sources.map((source) => source.columnCount)).toEqual([3, 2]);
    expect(first.columns).toEqual(["name", "__DBX_PK_0", "amount", "region"]);
    expect(first.rows).toEqual([["Alice", 17, 10, "north"]]);
  });

  it("matches visible duplicate names and keeps unnamed columns at their source ordinals", () => {
    const merged = mergeMultiSourceResults(
      [
        { key: "a", label: "a", result: result(["id", "id", "id", ""], [[99, 1, 2, 3]], { hidden_column_indexes: [0] }) },
        { key: "b", label: "b", result: result(["id", "id", "__DBX_PK_0", ""], [[4, 5, 88, 6]], { hidden_column_indexes: [2] }) },
      ],
      { sourceColumnLabel: "Source" },
    );

    expect(merged.columns).toEqual(["Source", "id", "id", "column_4"]);
    expect(merged.rows).toEqual([
      ["a", 1, 2, 3],
      ["b", 4, 5, 6],
    ]);
    expect(merged.summaries.map((summary) => summary.sum)).toEqual([5, 7, 9]);
  });

  it("skips sources without a tabular payload instead of failing", () => {
    const merged = mergeMultiSourceResults(
      [
        { key: "a", label: "empty", result: result([], []) },
        { key: "b", label: "failed", result: result(["Error"], [["boom"]], { execution_error: true }) },
        { key: "c", label: "missing", result: undefined },
        { key: "d", label: "ok", result: result(["id"], [[7]]) },
      ],
      { sourceColumnLabel: "Source" },
    );

    expect(merged.sources.map((source) => source.label)).toEqual(["ok"]);
    expect(merged.skippedLabels).toEqual(["empty", "failed", "missing"]);
    expect(merged.rows).toEqual([["ok", 7]]);
  });

  it("caps merged rows and reports truncation", () => {
    const rows = Array.from({ length: 5 }, (_, index) => [index]);
    const merged = mergeMultiSourceResults(
      [
        { key: "a", label: "a", result: result(["n"], rows) },
        { key: "b", label: "b", result: result(["n"], rows) },
      ],
      { sourceColumnLabel: "Source", maxRows: 4 },
    );

    expect(merged.rowCount).toBe(4);
    expect(merged.truncated).toBe(true);
    expect(merged.rows.map((row) => row[0])).toEqual(["a", "a", "a", "a"]);
  });

  it("names unnamed columns positionally and tolerates ragged rows", () => {
    const merged = mergeMultiSourceResults(
      [
        { key: "a", label: "a", result: result(["", "b"], [[1]]) },
        { key: "b", label: "b", result: result(["b"], [[2, 3, 4]]) },
      ],
      { sourceColumnLabel: "Source" },
    );

    expect(merged.columns).toEqual(["Source", "column_1", "b"]);
    expect(merged.rows).toEqual([
      ["a", 1, null],
      ["b", null, 2],
    ]);
  });

  it("summarizes every all-numeric column of the merged table and never the source column", () => {
    const merged = mergeMultiSourceResults(
      [
        { key: "a", label: "conn-a", result: result(["id", "amount", "label"], [[1, 10, "x"]]) },
        { key: "b", label: "conn-b", result: result(["id", "amount", "label"], [[2, 32.5, "y"]]) },
      ],
      { sourceColumnLabel: "Source" },
    );

    expect(merged.summaries).toEqual([
      { columnIndex: 1, column: "id", sum: 3, count: 2 },
      { columnIndex: 2, column: "amount", sum: 42.5, count: 2 },
    ]);
  });

  it("uses the documented row cap by default", () => {
    expect(MULTI_SOURCE_MERGE_MAX_ROWS).toBe(50_000);
  });

  it("handles no usable input with an empty table", () => {
    const merged = mergeMultiSourceResults([{ key: "a", label: "a", result: undefined }], { sourceColumnLabel: "Source" });
    expect(merged.columns).toEqual(["Source"]);
    expect(merged.rows).toEqual([]);
    expect(merged.sources).toEqual([]);
    expect(merged.summaries).toEqual([]);
    expect(merged.skippedLabels).toEqual(["a"]);
  });
});

describe("summarizeNumericColumns", () => {
  it("classifies numeric cells and rejects everything else", () => {
    expect(isNumericSummaryCellValue(1)).toBe(true);
    expect(isNumericSummaryCellValue(" 3.5 ")).toBe(true);
    expect(isNumericSummaryCellValue("")).toBe(false);
    expect(isNumericSummaryCellValue("12abc")).toBe(false);
    expect(isNumericSummaryCellValue("2026-07-24")).toBe(false);
    expect(isNumericSummaryCellValue(true)).toBe(false);
    expect(isNumericSummaryCellValue(null)).toBe(false);
    expect(isNumericSummaryCellValue(Number.NaN)).toBe(false);
  });

  it("ignores empty cells and drops a column once one value is not numeric", () => {
    expect(
      summarizeNumericColumns(
        ["a", "b"],
        [
          [1, null],
          [null, "n/a"],
          ["", 3],
        ],
      ),
    ).toEqual([{ columnIndex: 0, column: "a", sum: 1, count: 1 }]);
  });

  it("never sums boolean or all-empty columns", () => {
    expect(summarizeNumericColumns(["flag"], [[true], [false]])).toEqual([]);
    expect(summarizeNumericColumns(["a"], [[null], [null]])).toEqual([]);
  });
});
