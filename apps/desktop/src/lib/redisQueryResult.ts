import type { QueryResult } from "@/types/database";
import { formatRedisCommandResult } from "@/lib/redisValuePresentation";

export function redisCommandResultToQueryResult(value: unknown, elapsedMs: number): QueryResult {
  if (Array.isArray(value)) {
    const rows = value.map((item) => [formatRedisCommandResult(item)]);
    return {
      columns: ["(index)", "value"],
      rows: rows.map((row, i) => [i + 1, row[0]!]),
      affected_rows: value.length,
      execution_time_ms: Math.max(0, Math.round(elapsedMs)),
    };
  }
  return {
    columns: ["result"],
    rows: [[formatRedisCommandResult(value)]],
    affected_rows: 0,
    execution_time_ms: Math.max(0, Math.round(elapsedMs)),
  };
}
