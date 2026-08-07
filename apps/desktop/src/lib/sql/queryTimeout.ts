import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { ConnectionConfig, DatabaseType } from "@/types/database";

export const DEFAULT_QUERY_TIMEOUT_SECS = 60;

const POSTGRES_ROW_STATEMENT_KEYWORDS = new Set(["select", "show", "explain", "table", "with"]);
const POSTGRES_RETURNING_STATEMENT_KEYWORDS = new Set(["insert", "update", "delete", "merge"]);

export function queryTimeoutSecsForConnection(connection?: Pick<ConnectionConfig, "query_timeout_secs"> | null): number {
  const value = Number(connection?.query_timeout_secs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_QUERY_TIMEOUT_SECS;
}

export function frontendQueryTimeoutSecsForSql(sql: string, databaseType: DatabaseType | undefined, queryTimeoutSecs: number): number {
  if (queryTimeoutSecs === 0) return 0;

  // PostgreSQL applies the configured timeout while the backend receives rows
  // over a slow SSH tunnel. An absolute browser-side deadline can reject a
  // successful, steadily progressing page fetch first, so let the backend own
  // the timeout for row-returning PostgreSQL statements.
  if (databaseType === "postgres" && postgresQueryMayReturnRows(sql, databaseType)) return 0;

  const baseTimeoutSecs = Math.max(queryTimeoutSecs * 2, 60);
  const statementCount = Math.max(splitSqlStatementRanges(sql, databaseType).length, 1);
  return baseTimeoutSecs * statementCount;
}

function postgresQueryMayReturnRows(sql: string, databaseType: DatabaseType): boolean {
  return splitSqlStatementRanges(sql, databaseType).some(({ sql: statement }) => {
    const tokens = tokenizeSqlSemantic(statement, "postgres");
    const firstKeyword = tokens.find((token) => token.kind === "word" && token.depth === 0)?.normalized;
    if (!firstKeyword) return false;
    if (POSTGRES_ROW_STATEMENT_KEYWORDS.has(firstKeyword)) return true;
    if (!POSTGRES_RETURNING_STATEMENT_KEYWORDS.has(firstKeyword)) return false;
    return tokens.some((token) => token.kind === "word" && token.depth === 0 && token.normalized === "returning");
  });
}
