import type { QueryResult } from "@/types/database";
import { formatRedisCommandResult } from "@/lib/redisValuePresentation";

const KEY_VALUE_COMMANDS = new Set(["HGETALL"]);

function isKeyValueCommand(command: string): boolean {
  return KEY_VALUE_COMMANDS.has(command.toUpperCase().trim());
}

export function redisCommandResultToQueryResult(value: unknown, elapsedMs: number, command?: string): QueryResult {
  if (Array.isArray(value) && command && isKeyValueCommand(command)) {
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 0; i + 1 < value.length; i += 2) {
      rows.push([formatRedisCommandResult(value[i]), formatRedisCommandResult(value[i + 1])]);
    }
    return {
      columns: ["field", "value"],
      rows,
      affected_rows: value.length / 2,
      execution_time_ms: Math.max(0, Math.round(elapsedMs)),
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
      execution_time_ms: Math.max(0, Math.round(elapsedMs)),
    };
  }
  if (Array.isArray(value)) {
    const rows: (string | number | boolean | null)[][] = value.map((item, i) => [i + 1, formatRedisCommandResult(item)]);
    return {
      columns: ["(index)", "value"],
      rows,
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
