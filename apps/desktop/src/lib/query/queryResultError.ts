import type { QueryResult } from "@/types/database";

// Lake/external tables (e.g. Paimon in StarRocks) return this error on a data
// read when no snapshot exists yet, while metadata reads (DESC/SHOW CREATE)
// still succeed. executeTabSql surfaces query failures as an "Error" result, so
// callers can detect this case and fall back to a structure-only (LIMIT 0)
// preview instead of showing a cryptic server error.
const NO_SNAPSHOT_ERROR_PATTERN = /there is currently no snapshot/i;

export function isNoSnapshotErrorResult(result: QueryResult | undefined | null): boolean {
  if (!result || !result.columns.includes("Error") || result.rows.length === 0) return false;
  return NO_SNAPSHOT_ERROR_PATTERN.test(String(result.rows[0]?.[0] ?? ""));
}
