import { describe, expect, it } from "vitest";
import { resolveDisplayResult } from "../dataViewResultDisplay";
import type { DataViewQuery, DataViewQueryResult } from "@/types/dataView";

function makeQuery(overrides: Partial<DataViewQuery> = {}): DataViewQuery {
  return { id: "q1", connectionId: "conn-1", sqlTemplate: "HGETALL myhash", ...overrides };
}

describe("resolveDisplayResult", () => {
  it("passes through result.result when redisValue is absent", () => {
    const result: DataViewQueryResult = { queryId: "q1", title: "Query", displayMode: "table", result: { columns: ["a"], rows: [[1]], affected_rows: 1, execution_time_ms: 5 } };
    expect(resolveDisplayResult(result, makeQuery())).toBe(result.result);
  });

  it("converts a redis value into a tabular QueryResult using the matching query's command", () => {
    const result: DataViewQueryResult = { queryId: "q1", title: "Query", displayMode: "table", redisValue: ["field1", "value1", "field2", "value2"] };
    const converted = resolveDisplayResult(result, makeQuery({ sqlTemplate: "HGETALL myhash" }));
    expect(converted).toEqual({
      columns: ["field", "value"],
      rows: [
        ["field1", "value1"],
        ["field2", "value2"],
      ],
      affected_rows: 2,
      execution_time_ms: 0,
    });
  });

  it("falls back to a scalar table when no query is provided", () => {
    const result: DataViewQueryResult = { queryId: "q1", title: "Query", displayMode: "table", redisValue: "OK" };
    expect(resolveDisplayResult(result, undefined)).toEqual({
      columns: ["result"],
      rows: [["OK"]],
      affected_rows: 0,
      execution_time_ms: 0,
    });
  });

  it("treats a null redisValue as present (converted), not passthrough", () => {
    const result: DataViewQueryResult = { queryId: "q1", title: "Query", displayMode: "table", redisValue: null, result: undefined };
    expect(resolveDisplayResult(result, makeQuery())).toEqual({
      columns: ["result"],
      rows: [["null"]],
      affected_rows: 0,
      execution_time_ms: 0,
    });
  });
});
