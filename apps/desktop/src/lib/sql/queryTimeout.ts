import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import type { ConnectionConfig, DatabaseType } from "@/types/database";

export const DEFAULT_QUERY_TIMEOUT_SECS = 60;

export function queryTimeoutSecsForConnection(connection?: Pick<ConnectionConfig, "query_timeout_secs"> | null): number {
  const value = Number(connection?.query_timeout_secs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_QUERY_TIMEOUT_SECS;
}

export function frontendQueryTimeoutSecsForSql(sql: string, databaseType: DatabaseType | undefined, queryTimeoutSecs: number): number {
  if (queryTimeoutSecs === 0) return 0;

  const baseTimeoutSecs = Math.max(queryTimeoutSecs * 2, 60);
  const statementCount = Math.max(splitSqlStatementRanges(sql, databaseType).length, 1);
  return baseTimeoutSecs * statementCount;
}
