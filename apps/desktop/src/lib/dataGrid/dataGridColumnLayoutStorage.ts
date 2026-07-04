import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const STORAGE_PREFIX = "dbx-data-grid-column-layout:";
const STORAGE_VERSION = 1;

export interface DataGridColumnLayoutScope {
  connectionId?: string;
  database?: string;
  schema?: string;
  context?: string;
  tableSchema?: string;
  tableName?: string;
  sql?: string;
  columns: readonly string[];
  sourceColumns?: readonly (string | undefined)[];
}

interface StoredDataGridColumnLayout {
  version: number;
  columnSignature: string;
  order: string[];
}

function normalizeSql(sql?: string): string {
  return (sql ?? "").replace(/\s+/g, " ").trim();
}

export function dataGridColumnLayoutScopeKey(scope: DataGridColumnLayoutScope): string {
  const columnSignature = scope.columns.join("\0");
  const sourceSignature = (scope.sourceColumns ?? []).map((column) => column ?? "").join("\0");
  return [scope.connectionId ?? "", scope.database ?? "", scope.schema ?? "", scope.context ?? "", scope.tableSchema ?? "", scope.tableName ?? "", scope.tableName ? "" : normalizeSql(scope.sql), columnSignature, sourceSignature].join("\u0001");
}

export function loadDataGridColumnOrder(scopeKey: string, columnKeys: readonly string[]): string[] {
  const raw = safeLocalStorageGet(`${STORAGE_PREFIX}${scopeKey}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDataGridColumnLayout>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.order)) return [];
    if (parsed.columnSignature && parsed.columnSignature !== columnKeys.join("\0")) return [];
    return parsed.order.filter((key): key is string => typeof key === "string");
  } catch {
    return [];
  }
}

export function saveDataGridColumnOrder(scopeKey: string, columnKeys: readonly string[], order: readonly string[]) {
  const payload: StoredDataGridColumnLayout = {
    version: STORAGE_VERSION,
    columnSignature: columnKeys.join("\0"),
    order: [...order],
  };
  safeLocalStorageSet(`${STORAGE_PREFIX}${scopeKey}`, JSON.stringify(payload));
}

export function removeDataGridColumnOrder(scopeKey: string) {
  safeLocalStorageRemove(`${STORAGE_PREFIX}${scopeKey}`);
}
