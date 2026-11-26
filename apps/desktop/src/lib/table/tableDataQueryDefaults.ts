import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import type { QueryResult } from "@/types/database";

export interface TableDataQueryDefaultsScope {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  tableName: string;
}

export interface TableDataQueryDefaults {
  whereInput?: string;
  orderBy?: string;
}

function storageKey(scope: TableDataQueryDefaultsScope): string {
  return `dbx-table-query-defaults:${JSON.stringify([scope.connectionId, scope.catalog ?? "", scope.database, scope.schema || scope.database, scope.tableName])}`;
}

export function loadTableDataQueryDefaults(scope: TableDataQueryDefaultsScope): TableDataQueryDefaults | undefined {
  const raw = safeLocalStorageGet(storageKey(scope));
  if (!raw) return undefined;
  try {
    const saved = JSON.parse(raw) as Partial<TableDataQueryDefaults> | null;
    const whereInput = typeof saved?.whereInput === "string" ? saved.whereInput.trim() || undefined : undefined;
    const orderBy = typeof saved?.orderBy === "string" ? saved.orderBy.trim() || undefined : undefined;
    return whereInput || orderBy ? { whereInput, orderBy } : undefined;
  } catch {
    return undefined;
  }
}

export function saveTableDataQueryDefaults(scope: TableDataQueryDefaultsScope, defaults: TableDataQueryDefaults): boolean {
  return safeLocalStorageSet(storageKey(scope), JSON.stringify(defaults));
}

export function removeTableDataQueryDefaults(scope: TableDataQueryDefaultsScope) {
  safeLocalStorageRemove(storageKey(scope));
}

/**
 * Saved defaults are free-form SQL strings restored without validation against
 * the table's current columns: a filtered/sorted column dropped or renamed
 * between sessions makes the first query on reopen fail with a server error.
 * Mirrors the #12647 synthetic-row-id degradation contract: when the first
 * query of an open carried saved defaults and failed as an execution error
 * (not a user cancel), the open retries once without them and the stale
 * defaults are dropped so later opens stop failing.
 */
export function shouldRetryWithoutTableDataQueryDefaults(applied: TableDataQueryDefaults | undefined, result: QueryResult | undefined | null): boolean {
  if (!applied?.whereInput && !applied?.orderBy) return false;
  return !!result && isQueryExecutionErrorResult(result);
}
