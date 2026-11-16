import { DBX_ROWID_COLUMN } from "@/lib/table/tableEditing";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import type { QueryResult } from "@/types/database";

/**
 * Per-connection memory of engines that rejected the synthetic row-id locator.
 *
 * Keyless PostgreSQL-family tables are opened with a `tableoid`/`ctid`/`xmin`
 * locator projection (see buildTableSelectSql). PostgreSQL-compatible engines
 * without system-column support — Hologres' query translation layer rejects
 * `tableoid` (issue #12647) — fail every such table open with a db error.
 * On the first failure the grid retries once without the locator; a successful
 * retry remembers the connection so later opens skip the locator entirely
 * (keyless tables stay read-only there). Engines that also reject the
 * fallback restore the flag so the user sees the real server error again.
 */
const rowIdLocatorUnsupportedConnections = new Set<string>();

export function rowIdLocatorUnsupported(connectionId: string): boolean {
  return rowIdLocatorUnsupportedConnections.has(connectionId);
}

export function markRowIdLocatorUnsupported(connectionId: string): void {
  rowIdLocatorUnsupportedConnections.add(connectionId);
}

export function markRowIdLocatorSupported(connectionId: string): void {
  rowIdLocatorUnsupportedConnections.delete(connectionId);
}

export function resetRowIdLocatorStateForTests(): void {
  rowIdLocatorUnsupportedConnections.clear();
}

/** A failed data load whose SQL carried the locator is the retry trigger. */
export function shouldRetryWithoutRowIdLocator(sql: string, result: QueryResult | undefined | null): boolean {
  // The connection capability may have been updated by another tab while this
  // locator query was already in flight. The SQL itself is the authoritative
  // record of what was sent; every failed locator-bearing request still needs
  // its own fallback.
  return sql.includes(DBX_ROWID_COLUMN) && !!result && isQueryExecutionErrorResult(result);
}

/** Only a successful fallback keeps the flag; a failed one shows the real error. */
export function shouldKeepRowIdLocatorDisabled(result: QueryResult | undefined | null): boolean {
  return !!result && !isQueryExecutionErrorResult(result);
}
