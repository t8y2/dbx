import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import { stripPaginationRowNumber } from "@/lib/query/queryPaginationResult";

const result: QueryResult = {
  columns: ["__dbx_row_num", "shape", "__dbx_row_num"],
  rows: [["user value", "POINT(1 2)", 101]],
  column_types: ["VARCHAR", "GEOMETRY", "NUMBER"],
  column_sortables: [true, false, true],
  spatial_columns: [{ column_index: 1, srid: 4326 }],
  spatial_values: [[null, 4326, null]],
  large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 200 }],
  hidden_column_indexes: [0],
  affected_rows: 0,
  execution_time_ms: 1,
};

describe("pagination result columns", () => {
  it("removes only the generated trailing column and keeps user columns and metadata aligned", () => {
    const cleaned = stripPaginationRowNumber(result, "__dbx_row_num");
    expect(cleaned.columns).toEqual(["__dbx_row_num", "shape"]);
    expect(cleaned.rows).toEqual([["user value", "POINT(1 2)"]]);
    expect(cleaned.column_types).toEqual(["VARCHAR", "GEOMETRY"]);
    expect(cleaned.column_sortables).toEqual([true, false]);
    expect(cleaned.spatial_values).toEqual([[null, 4326]]);
    expect(cleaned.spatial_columns).toEqual(result.spatial_columns);
    expect(cleaned.large_value_cells).toEqual(result.large_value_cells);
    expect(cleaned.hidden_column_indexes).toEqual([0]);
    expect(result.columns).toHaveLength(3);
  });

  it("leaves user results untouched when the plan has no helper or the trailing name differs", () => {
    expect(stripPaginationRowNumber(result, undefined)).toBe(result);
    expect(stripPaginationRowNumber(result, "different_helper")).toBe(result);
  });
});
