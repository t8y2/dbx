import type { DatabaseType, QueryResult } from "@/types/database";

// Lake/external tables (e.g. Paimon in StarRocks) return this error on a data
// read when no snapshot exists yet, while metadata reads (DESC/SHOW CREATE)
// still succeed. executeTabSql surfaces query failures as an "Error" result, so
// callers can detect this case and fall back to a structure-only (LIMIT 0)
// preview instead of showing a cryptic server error.
const NO_SNAPSHOT_ERROR_PATTERN = /there is currently no snapshot/i;
const MYSQL_PROTOCOL_DATABASE_TYPES = new Set<DatabaseType>(["mysql", "doris", "starrocks", "manticoresearch"]);

export function usesMysqlProtocolDatabaseType(databaseType: DatabaseType | undefined): boolean {
  return databaseType !== undefined && MYSQL_PROTOCOL_DATABASE_TYPES.has(databaseType);
}

// The batch executor marks synthesized MySQL-protocol errors explicitly so a
// successful result column named Error is never mistaken for a failure.
export function isMysqlExecutionErrorResult(result: QueryResult, databaseType: DatabaseType | undefined): boolean {
  return usesMysqlProtocolDatabaseType(databaseType) && result.execution_error === true;
}

export function isQueryExecutionErrorResult(result: QueryResult): boolean {
  // Multi-database batch responses use this explicit marker so a successful
  // query column named Error is never promoted as the failed statement.
  return result.execution_error === true;
}

export function isNoSnapshotErrorResult(result: QueryResult | undefined | null): boolean {
  if (!result || !result.columns.includes("Error") || result.rows.length === 0) return false;
  return NO_SNAPSHOT_ERROR_PATTERN.test(String(result.rows[0]?.[0] ?? ""));
}
