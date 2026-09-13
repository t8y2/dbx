import { redisCommandResultToQueryResult } from "@/lib/redis/redisQueryResult";
import type { QueryResult } from "@/types/database";
import type { DataViewQuery, DataViewQueryResult } from "@/types/dataView";

/**
 * Redis queries carry a raw `redisValue` instead of a tabular `result` (the backend can't
 * reuse the frontend's command-aware value\u2192table heuristics without duplicating them in Rust).
 * Converts on demand so DataGrid/QueryChart never need to know about Redis specifically.
 */
export function resolveDisplayResult(result: DataViewQueryResult, query?: DataViewQuery): QueryResult | null | undefined {
  if (result.redisValue !== undefined) {
    return redisCommandResultToQueryResult(result.redisValue, 0, query?.sqlTemplate);
  }
  return result.result;
}
