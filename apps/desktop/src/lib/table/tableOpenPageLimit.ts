import { DEFAULT_RESULT_PAGE_SIZE, normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const DEFAULT_TABLE_OPEN_PAGE_LIMIT = DEFAULT_RESULT_PAGE_SIZE;

export interface TableOpenPageScope {
  connectionId: string;
  database: string;
  catalog?: string;
  schema?: string;
  tableName: string;
}

function tablePageSizeKey(scope: TableOpenPageScope): string {
  return `dbx-table-open-page-size:${JSON.stringify([scope.connectionId, scope.database, scope.catalog ?? "", scope.schema ?? "", scope.tableName])}`;
}

export function savedTableOpenPageSize(scope: TableOpenPageScope): number | undefined {
  const saved = Number(safeLocalStorageGet(tablePageSizeKey(scope)));
  return Number.isSafeInteger(saved) && saved === normalizeResultPageSize(saved) ? saved : undefined;
}

export function saveTableOpenPageSize(scope: TableOpenPageScope, size?: number): boolean {
  const key = tablePageSizeKey(scope);
  if (size !== undefined) return safeLocalStorageSet(key, String(normalizeResultPageSize(size)));
  safeLocalStorageRemove(key);
  return safeLocalStorageGet(key) === null;
}

export function tableOpenPageLimit(preferredLimit?: unknown, scope?: TableOpenPageScope): number {
  if (scope) {
    const saved = savedTableOpenPageSize(scope);
    if (saved !== undefined) return saved;
  }
  return normalizeResultPageSize(preferredLimit, DEFAULT_TABLE_OPEN_PAGE_LIMIT);
}
