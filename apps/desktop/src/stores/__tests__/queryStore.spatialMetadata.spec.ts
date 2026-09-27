import { describe, it, expect } from "vitest";
import { appendQueryResultSegment } from "@/stores/queryStore";
import type { QueryResult } from "@/types/database";

function make(rows: number, spatial?: QueryResult["spatial_columns"]): QueryResult {
  return {
    columns: ["geom"],
    column_types: ["geometry"],
    spatial_columns: spatial,
    rows: Array.from({ length: rows }, (_, i) => [`POINT(${i} ${i})`]),
    affected_rows: 0,
    execution_time_ms: 0,
  } as unknown as QueryResult;
}

describe("appendQueryResultSegment spatial merge", () => {
  it("sums client request wait across loaded pages", () => {
    const previous = { ...make(1), client_request_wait_ms: 45 };
    const segment = { ...make(1), client_request_wait_ms: 30 };
    const merged = appendQueryResultSegment(previous, segment, 100);
    expect(merged.client_request_wait_ms).toBe(75);
    expect(merged.rows).toHaveLength(2);
  });
  it("does not report a partial wait when either loaded page lacks a sample", () => {
    const sampled = { ...make(1), client_request_wait_ms: 40 };
    expect(appendQueryResultSegment(make(1), sampled, 100).client_request_wait_ms).toBeUndefined();
    expect(appendQueryResultSegment(sampled, make(1), 100).client_request_wait_ms).toBeUndefined();
  });
  it("keeps the first non-null SRID per column across pages", () => {
    const previous = make(2, [{ column_index: 0, srid: 4326 }]);
    const segment = make(2, [{ column_index: 0, srid: 3857 }]);
    const merged = appendQueryResultSegment(previous, segment, 100);
    expect(merged.spatial_columns).toEqual([{ column_index: 0, srid: 4326 }]);
    expect(merged.rows).toHaveLength(4);
  });

  it("adopts the segment SRID when the previous page was unknown", () => {
    const previous = make(1, [{ column_index: 0, srid: null }]);
    const segment = make(1, [{ column_index: 0, srid: 4490 }]);
    const merged = appendQueryResultSegment(previous, segment, 100);
    expect(merged.spatial_columns).toEqual([{ column_index: 0, srid: 4490 }]);
  });

  it("concatenates per-cell SRIDs across pages without collapsing", () => {
    const previous = make(2, [{ column_index: 0, srid: 4326 }]);
    previous.spatial_values = [[4326], [3857]];
    const segment = make(2, [{ column_index: 0, srid: null }]);
    segment.spatial_values = [[3857], [4490]];

    const merged = appendQueryResultSegment(previous, segment, 100);
    // Every row keeps its own SRID; a later page does not overwrite earlier cells.
    expect(merged.spatial_values).toEqual([[4326], [3857], [3857], [4490]]);
  });

  it("raises the structured segment error instead of reconstructing from the Error row", () => {
    const previous = make(1);
    const segment = {
      ...make(0),
      execution_error: true as const,
      rows: [["legacy row text"]],
      error: {
        version: 1 as const,
        code: "DBX-JDBC-4001",
        messageKey: "backendErrors.jdbc.sqlFailed",
        messageParams: { stage: "execute" },
        source: "jdbcAgent" as const,
        operationOutcome: "unknown" as const,
        detail: "relation missing_table does not exist",
      },
    } as unknown as QueryResult;

    expect(() => appendQueryResultSegment(previous, segment, 100)).toThrow("relation missing_table does not exist");
  });
});

describe("appendQueryResultSegment OceanBase audit timing", () => {
  it("uses the terminal audit for the whole JDBC cursor without summing page samples", () => {
    const first = { ...make(100), session_id: "cursor-1", has_more: true };
    const last = { ...make(50), server_execute_time_us: 370, has_more: false };
    expect(appendQueryResultSegment(first, last, 1000).server_execute_time_us).toBe(370);
  });

  it("sums independent SQL pages only when each page has an audit sample", () => {
    const first = { ...make(100), server_execute_time_us: 200 };
    const sampledNext = { ...make(100), server_execute_time_us: 150 };
    expect(appendQueryResultSegment(first, sampledNext, 1000).server_execute_time_us).toBe(350);
    expect(appendQueryResultSegment(make(100), sampledNext, 1000).server_execute_time_us).toBeUndefined();
    expect(appendQueryResultSegment(first, make(100), 1000).server_execute_time_us).toBeUndefined();
  });
});
