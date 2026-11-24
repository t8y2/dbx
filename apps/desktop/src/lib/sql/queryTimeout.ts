import { splitSqlStatementRanges, sqlStatementParameterOptionsForCompatibility } from "@/lib/sql/sqlStatementRanges";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import { classifySqlRisk } from "@/lib/sql/sqlRisk";
import { DEFAULT_QUERY_TIMEOUT_SECS, MAX_QUERY_TIMEOUT_SECS } from "@/lib/connection/timeoutLimits";
import type { ConnectionConfig, DatabaseType } from "@/types/database";

export { DEFAULT_QUERY_TIMEOUT_SECS } from "@/lib/connection/timeoutLimits";

/**
 * Writes are unlimited by default.
 *
 * A read timeout only costs a retry. A write timeout costs certainty: the client
 * cannot tell whether the rows landed, so retrying duplicates data and not
 * retrying loses it. Let the user decide, and never let the deadline cancel the
 * server statement even when they do set one.
 */
export const DEFAULT_WRITE_TIMEOUT_SECS = 0;

/**
 * Query timeout (seconds) the table structure editor applies when the change
 * script contains a PostgreSQL `CREATE INDEX CONCURRENTLY`.
 *
 * Concurrent builds scan the whole table while only taking `ShareUpdateExclusiveLock`,
 * so they routinely run far beyond the default 60s query timeout — the default
 * budget would cancel a legitimate build and leave an INVALID index behind.
 * PostgreSQL itself does not impose a build deadline
 * (https://www.postgresql.org/docs/current/sql-createindex.html). This is the
 * dedicated 30-minute floor used by `queryTimeoutSecsForConcurrentIndex` for
 * such statements; it never overrides an unlimited setting (0) and never
 * shortens a larger configured timeout.
 */
export const CONCURRENT_INDEX_QUERY_TIMEOUT_SECS = 1800;
const MAX_BROWSER_TIMER_DELAY_MS = 2_147_483_647;

const POSTGRES_ROW_STATEMENT_KEYWORDS = new Set(["select", "show", "explain", "table", "with"]);
const POSTGRES_RETURNING_STATEMENT_KEYWORDS = new Set(["insert", "update", "delete", "merge"]);

export function queryTimeoutSecsForConnection(connection?: Pick<ConnectionConfig, "query_timeout_secs" | "query_timeout_inherit"> | null, globalQueryTimeoutSecs = DEFAULT_QUERY_TIMEOUT_SECS): number {
  if (connection?.query_timeout_inherit === true) {
    const globalValue = Number(globalQueryTimeoutSecs);
    return Number.isFinite(globalValue) && globalValue >= 0 ? globalValue : DEFAULT_QUERY_TIMEOUT_SECS;
  }
  const value = Number(connection?.query_timeout_secs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_QUERY_TIMEOUT_SECS;
}

export function writeTimeoutSecsForConnection(connection?: Pick<ConnectionConfig, "write_timeout_secs"> | null): number {
  return normalizeWriteTimeoutSecs(connection?.write_timeout_secs);
}

export function normalizeWriteTimeoutSecs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_WRITE_TIMEOUT_SECS;
  return Math.min(MAX_QUERY_TIMEOUT_SECS, Math.round(value));
}

/**
 * Effective query timeout (seconds) for a table-structure change script.
 *
 * Concurrent builds use at least the dedicated 30-minute floor while
 * preserving an unlimited setting (0) and any larger configured timeout.
 * Non-concurrent scripts keep the configured timeout unchanged.
 */
export function queryTimeoutSecsForConcurrentIndex(configuredTimeoutSecs: number, hasConcurrentIndexBuild: boolean): number {
  if (!hasConcurrentIndexBuild) return configuredTimeoutSecs;
  if (configuredTimeoutSecs === 0) return 0;
  return Math.max(configuredTimeoutSecs, CONCURRENT_INDEX_QUERY_TIMEOUT_SECS);
}

/**
 * What a script is allowed to change. Mirrors `StatementScope` in
 * `dbx-core/src/query/mod.rs`; the two must agree or the client and the server
 * will disagree about whether a statement may be cancelled.
 */
export type StatementScope = "read" | "write" | "schema-change";

const SCHEMA_CHANGE_KEYWORDS = new Set(["create", "alter", "drop", "truncate", "rename", "comment", "grant", "revoke", "reindex", "vacuum", "analyze", "analyse", "optimize", "repair"]);

const WRITE_KEYWORDS = new Set(["insert", "update", "delete", "merge", "upsert", "replace", "copy", "load", "import", "call", "exec", "execute"]);

function statementKeywordScope(statement: string, databaseType: DatabaseType | undefined): StatementScope | undefined {
  const tokens = tokenizeSqlSemantic(statement, databaseType ?? "mysql");
  const firstKeyword = tokens.find((token) => token.kind === "word" && token.depth === 0)?.normalized;
  if (!firstKeyword) return undefined;
  if (databaseType === "sqlserver" && firstKeyword === "waitfor") {
    const significant = tokens.filter((token) => token.kind !== "comment");
    if (significant[significant.length - 1]?.text === ";") significant.pop();
    const [verb, mode, time] = significant;
    const literalWait = significant.length === 3 && verb.kind === "word" && verb.normalized === "waitfor" && mode.kind === "word" && ["delay", "time"].includes(mode.normalized) && time.kind === "string" && time.quote === "'" && time.closed;
    // A bare delay only waits. WAITFOR (RECEIVE ...) consumes queue messages.
    return literalWait ? "read" : "write";
  }
  if (SCHEMA_CHANGE_KEYWORDS.has(firstKeyword)) return "schema-change";
  if (WRITE_KEYWORDS.has(firstKeyword)) return "write";
  return undefined;
}

/**
 * Classify a script by its most privileged statement: schema changes beat writes
 * beat reads. `ALTER TABLE ... ADD PARTITION` and other vendor extensions a
 * parser cannot handle are covered by the leading keyword, so an unparsed
 * statement never falls back to the read deadline.
 */
export function statementScopeForSql(sql: string, databaseType: DatabaseType | undefined, parameterOptions?: SqlParameterOptions): StatementScope {
  const statements = splitSqlStatementRanges(sql, databaseType, parameterOptions ?? sqlStatementParameterOptionsForCompatibility(databaseType));
  let scope: StatementScope = "read";
  for (const { sql: statement } of statements) {
    const keywordScope = statementKeywordScope(statement, databaseType);
    if (keywordScope === "schema-change") return "schema-change";
    const risks = classifySqlRisk(statement, { dialect: databaseType }).statements;
    if (risks.some(({ risk }) => risk === "ddl")) return "schema-change";
    if (keywordScope === "write" || risks.some(({ risk }) => risk === "write" || risk === "transaction")) scope = "write";
  }
  return scope;
}

/** True when the script contains a statement that must outlive the read budget. */
export function statementOutlivesReadTimeoutBudget(sql: string, databaseType: DatabaseType | undefined, parameterOptions?: SqlParameterOptions): boolean {
  return statementScopeForSql(sql, databaseType, parameterOptions) !== "read";
}

export interface StatementDeadline {
  /** Seconds the client waits before it stops. `0` means no deadline. */
  afterSecs: number;
  /** Whether the client may cancel the server statement when the deadline hits. */
  cancelOnTimeout: boolean;
}

/**
 * Deadline for one script execution.
 *
 * - schema changes: never bounded (no sensible default exists, and a cancel
 *   leaves the server rolling back while it holds metadata locks)
 * - writes: `writeTimeoutSecs`, and the deadline never cancels
 * - reads: `queryTimeoutSecs`, cancellable
 */
export function frontendDeadlineForStatement(sql: string, databaseType: DatabaseType | undefined, queryTimeoutSecs: number, writeTimeoutSecs: number, parameterOptions?: SqlParameterOptions): StatementDeadline {
  const scope = statementScopeForSql(sql, databaseType, parameterOptions);
  if (scope === "schema-change") return { afterSecs: 0, cancelOnTimeout: false };
  if (scope === "write") {
    return writeTimeoutSecs > 0 ? { afterSecs: writeTimeoutSecs, cancelOnTimeout: false } : { afterSecs: 0, cancelOnTimeout: false };
  }
  const afterSecs = frontendReadTimeoutSecs(sql, databaseType, queryTimeoutSecs, parameterOptions);
  return { afterSecs, cancelOnTimeout: afterSecs > 0 };
}

export function frontendDeadlineForConnection(
  sql: string,
  databaseType: DatabaseType | undefined,
  connection?: Pick<ConnectionConfig, "query_timeout_secs" | "query_timeout_inherit" | "write_timeout_secs"> | null,
  globalQueryTimeoutSecs = DEFAULT_QUERY_TIMEOUT_SECS,
  parameterOptions?: SqlParameterOptions,
): StatementDeadline {
  return frontendDeadlineForStatement(sql, databaseType, queryTimeoutSecsForConnection(connection, globalQueryTimeoutSecs), writeTimeoutSecsForConnection(connection), parameterOptions);
}

export function frontendQueryTimeoutSecsForSql(sql: string, databaseType: DatabaseType | undefined, queryTimeoutSecs: number, parameterOptions?: SqlParameterOptions): number {
  if (statementOutlivesReadTimeoutBudget(sql, databaseType, parameterOptions)) return 0;
  return frontendReadTimeoutSecs(sql, databaseType, queryTimeoutSecs, parameterOptions);
}

function frontendReadTimeoutSecs(sql: string, databaseType: DatabaseType | undefined, queryTimeoutSecs: number, parameterOptions?: SqlParameterOptions): number {
  // PostgreSQL applies the configured timeout while the backend receives rows
  // over a slow SSH tunnel. An absolute browser-side deadline can reject a
  // successful, steadily progressing page fetch first, so let the backend own
  // the timeout for row-returning PostgreSQL statements.
  if (databaseType === "postgres" && postgresQueryMayReturnRows(sql, databaseType)) return 0;

  const statementCount = Math.max(splitSqlStatementRanges(sql, databaseType, parameterOptions ?? sqlStatementParameterOptionsForCompatibility(databaseType)).length, 1);
  return queryTimeoutSecs * statementCount;
}

export function frontendQueryTimeoutDelayMs(timeoutSecs: number): number | undefined {
  const timeoutMs = timeoutSecs * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BROWSER_TIMER_DELAY_MS) return undefined;
  return timeoutMs;
}

function postgresQueryMayReturnRows(sql: string, databaseType: DatabaseType): boolean {
  return splitSqlStatementRanges(sql, databaseType, sqlStatementParameterOptionsForCompatibility(databaseType)).some(({ sql: statement }) => {
    const tokens = tokenizeSqlSemantic(statement, "postgres");
    const firstKeyword = tokens.find((token) => token.kind === "word" && token.depth === 0)?.normalized;
    if (!firstKeyword) return false;
    if (POSTGRES_ROW_STATEMENT_KEYWORDS.has(firstKeyword)) return true;
    if (!POSTGRES_RETURNING_STATEMENT_KEYWORDS.has(firstKeyword)) return false;
    return tokens.some((token) => token.kind === "word" && token.depth === 0 && token.normalized === "returning");
  });
}
