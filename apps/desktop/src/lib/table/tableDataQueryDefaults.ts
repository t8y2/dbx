import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

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
