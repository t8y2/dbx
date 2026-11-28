import { DBX_ROWID_COLUMN } from "@/lib/table/tableEditing";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import type { QueryResult } from "@/types/database";

/**
 * Session memory of tables/connections that rejected the synthetic row-id locator.
 *
 * Keyless PostgreSQL-family tables are opened with a `tableoid`/`ctid`/`xmin`
 * locator projection (see buildTableSelectSql). PostgreSQL-compatible engines
 * without system-column support — Hologres' query translation layer rejects
 * `tableoid` (issue #12647) — fail every such table open with a db error.
 * On the first failure the grid retries once without the locator; a successful
 * retry remembers the rejection so later opens skip the locator entirely
 * (keyless tables stay read-only there). Engines that also reject the
 * fallback restore the flag so the user sees the real server error again.
 *
 * The rejection is remembered per table when the failing table is known:
 * on PolarDB the restriction is per access method, so one `polar_duckdb`
 * column-store table rejecting the locator must not strip it from the heap
 * tables on the same connection (#15865). A mark without a table key stays
 * connection-wide for flows that cannot attribute the failure to one table.
 */
const rowIdLocatorUnsupportedEntries = new Set<string>();

/** Stable identity of one table for locator-support memory. */
export function rowIdLocatorTableKey(connectionId: string, database: string | undefined, schema: string | undefined, catalog: string | undefined, tableName: string): string {
  return JSON.stringify([connectionId, database ?? null, schema || "public", catalog ?? null, tableName]);
}

export function rowIdLocatorUnsupported(connectionId: string, tableKey?: string): boolean {
  if (rowIdLocatorUnsupportedEntries.has(connectionId)) return true;
  return !!tableKey && rowIdLocatorUnsupportedEntries.has(tableKey);
}

export function markRowIdLocatorUnsupported(connectionId: string, tableKey?: string): void {
  rowIdLocatorUnsupportedEntries.add(tableKey ?? connectionId);
}

export function markRowIdLocatorSupported(connectionId: string, tableKey?: string): void {
  rowIdLocatorUnsupportedEntries.delete(tableKey ?? connectionId);
}

export function resetRowIdLocatorStateForTests(): void {
  rowIdLocatorUnsupportedEntries.clear();
}

/** A failed data load whose SQL carried the locator is the retry trigger. */
export function shouldRetryWithoutRowIdLocator(sql: string, result: QueryResult | undefined | null): boolean {
  // The connection capability may have been updated by another tab while this
  // locator query was already in flight. The SQL itself is the authoritative
  // record of what was sent; every failed locator-bearing request still needs
  // its own fallback.
  return sql.includes(DBX_ROWID_COLUMN) && !!result && isQueryExecutionErrorResult(result);
}

/** Match explicit PostgreSQL-compatible engine errors, excluding transport failures. */
export function isPostgresTupleLocatorRejection(message: string): boolean {
  return /\bsystem column ["']?(?:tableoid|ctid|xmin)["']? is not supported\b/i.test(message) || /\bvariable (?:tableoid|ctid|xmin)\b[^\r\n]*can't be found in query translation/i.test(message);
}

/** Only a successful fallback keeps the flag; a failed one shows the real error. */
export function shouldKeepRowIdLocatorDisabled(result: QueryResult | undefined | null): boolean {
  return !!result && !isQueryExecutionErrorResult(result);
}
