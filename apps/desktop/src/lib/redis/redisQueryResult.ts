import type { QueryResult } from "@/types/database";
import { formatRedisCommandResult, formatRedisConsoleError, formatRedisConsoleValue, redisCommandResultPairKind } from "@/lib/redis/redisValuePresentation";

export interface RedisQueryConsoleEntry {
  command: string;
  output: string;
  error: boolean;
}

export function redisQueryResultsToConsoleEntries(results: readonly QueryResult[]): RedisQueryConsoleEntry[] {
  return results.flatMap((result) => {
    const error = result.execution_error === true;
    const output = error ? formatRedisConsoleError(result.rows[0]?.[0]) : result.redis_console_output;
    if (output === undefined) return [];
    return [{ command: result.sourceStatement?.trim() ?? "", output, error }];
  });
}

export function redisCommandResultToQueryResult(value: unknown, elapsedMs: number, command?: string): QueryResult {
  const execution_time_ms = Math.max(0, Math.round(elapsedMs));
  const redis_console_output = formatRedisConsoleValue(value, command);
  const pairKind = redisCommandResultPairKind(command);
  if (Array.isArray(value) && pairKind === "field-value") {
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 0; i + 1 < value.length; i += 2) {
      rows.push([formatRedisCommandResult(value[i]), formatRedisCommandResult(value[i + 1])]);
    }
    return {
      columns: ["field", "value"],
      rows,
      affected_rows: value.length / 2,
      execution_time_ms,
      redis_console_output,
    };
  }
  if (Array.isArray(value) && pairKind === "member-score") {
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 0; i + 1 < value.length; i += 2) {
      rows.push([formatRedisCommandResult(value[i]), formatRedisCommandResult(value[i + 1])]);
    }
    return {
      columns: ["member", "score"],
      rows,
      affected_rows: rows.length,
      execution_time_ms,
      redis_console_output,
    };
  }
  // INFO commands in cluster mode → [[node_addr, info_text], ...] pairs.
  // Render as a two-column table with the addr as the index and info text as the value.
  if (Array.isArray(value) && value.length > 0 && value.every((item) => Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && typeof item[1] === "string")) {
    const rows: (string | number | boolean | null)[][] = value.map((item: [string, string]) => [item[0], item[1]]);
    return {
      columns: ["(index)", "value"],
      rows,
      affected_rows: value.length,
      execution_time_ms,
      redis_console_output,
    };
  }
  if (Array.isArray(value)) {
    const rows: (string | number | boolean | null)[][] = value.map((item, i) => [i + 1, formatRedisCommandResult(item)]);
    return {
      columns: ["(index)", "value"],
      rows,
      affected_rows: value.length,
      execution_time_ms,
      redis_console_output,
    };
  }
  return {
    columns: ["result"],
    rows: [[formatRedisCommandResult(value)]],
    affected_rows: 0,
    execution_time_ms,
    redis_console_output,
  };
}
