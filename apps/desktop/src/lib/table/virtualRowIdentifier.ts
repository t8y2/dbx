import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { ColumnInfo } from "@/types/database";

const STORAGE_PREFIX = "dbx-table-virtual-row-identifier:";
const STORAGE_VERSION = 1;

export interface VirtualRowIdentifierScope {
  connectionId: string;
  database: string;
  catalog?: string;
  schema?: string;
  tableName: string;
}

interface StoredVirtualRowIdentifier {
  version: number;
  columns: string[];
}

export function virtualRowIdentifierScopeKey(scope: VirtualRowIdentifierScope): string {
  return JSON.stringify([scope.connectionId, scope.database, scope.catalog ?? "", scope.schema ?? "", scope.tableName]);
}

export function resolveRowIdentifierColumns(requestedColumns: readonly string[], availableColumns: readonly Pick<ColumnInfo, "name">[]): string[] | null {
  if (requestedColumns.length === 0 || availableColumns.length === 0) return null;
  const resolved: string[] = [];

  for (const requested of requestedColumns) {
    const exact = availableColumns.find((column) => column.name === requested);
    const foldedMatches = exact ? [] : availableColumns.filter((column) => column.name.toLowerCase() === requested.toLowerCase());
    const canonical = exact?.name ?? (foldedMatches.length === 1 ? foldedMatches[0]!.name : undefined);
    if (!canonical || resolved.includes(canonical)) return null;
    resolved.push(canonical);
  }

  return resolved;
}

export function loadVirtualRowIdentifier(scope: VirtualRowIdentifierScope, availableColumns: readonly Pick<ColumnInfo, "name">[]): string[] {
  if (availableColumns.length === 0) return [];
  const storageKey = `${STORAGE_PREFIX}${virtualRowIdentifierScopeKey(scope)}`;
  const raw = safeLocalStorageGet(storageKey);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Partial<StoredVirtualRowIdentifier>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.columns) || !parsed.columns.every((column) => typeof column === "string")) {
      safeLocalStorageRemove(storageKey);
      return [];
    }
    const columns = resolveRowIdentifierColumns(parsed.columns, availableColumns);
    if (!columns) {
      safeLocalStorageRemove(storageKey);
      return [];
    }
    if (columns.some((column, index) => column !== parsed.columns![index])) {
      safeLocalStorageSet(storageKey, JSON.stringify({ version: STORAGE_VERSION, columns } satisfies StoredVirtualRowIdentifier));
    }
    return columns;
  } catch {
    safeLocalStorageRemove(storageKey);
    return [];
  }
}

export function saveVirtualRowIdentifier(scope: VirtualRowIdentifierScope, selectedColumns: readonly string[], availableColumns: readonly Pick<ColumnInfo, "name">[]): boolean {
  const columns = resolveRowIdentifierColumns(selectedColumns, availableColumns);
  if (!columns) return false;
  return safeLocalStorageSet(`${STORAGE_PREFIX}${virtualRowIdentifierScopeKey(scope)}`, JSON.stringify({ version: STORAGE_VERSION, columns } satisfies StoredVirtualRowIdentifier));
}

export function removeVirtualRowIdentifier(scope: VirtualRowIdentifierScope): void {
  safeLocalStorageRemove(`${STORAGE_PREFIX}${virtualRowIdentifierScopeKey(scope)}`);
}
