import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const STORAGE_PREFIX = "dbx-data-grid-column-layout:";
const TABLE_STORAGE_PREFIX = "dbx-data-grid-table-column-order:";
const STORAGE_VERSION = 1;

export const TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT = "dbx:table-data-grid-column-order-changed";

export interface TableDataGridColumnOrderChangedDetail {
  scopeKey: string;
}

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

export interface TableDataGridColumnOrderScope {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
}

interface StoredTableDataGridColumnOrder {
  version: number;
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

export function tableDataGridColumnOrderScopeKey(scope: TableDataGridColumnOrderScope): string {
  const namespace = scope.schema?.trim() || scope.database;
  return [scope.connectionId, scope.database, namespace, scope.tableName].join("\u0001");
}

export function loadTableDataGridColumnOrder(scopeKey: string): string[] {
  const raw = safeLocalStorageGet(`${TABLE_STORAGE_PREFIX}${scopeKey}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTableDataGridColumnOrder>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.order)) return [];
    return parsed.order.filter((key): key is string => typeof key === "string");
  } catch {
    return [];
  }
}

export function saveTableDataGridColumnOrder(scopeKey: string, order: readonly string[]) {
  const payload: StoredTableDataGridColumnOrder = {
    version: STORAGE_VERSION,
    order: [...order],
  };
  safeLocalStorageSet(`${TABLE_STORAGE_PREFIX}${scopeKey}`, JSON.stringify(payload));
}

export function removeTableDataGridColumnOrder(scopeKey: string) {
  safeLocalStorageRemove(`${TABLE_STORAGE_PREFIX}${scopeKey}`);
}

export function notifyTableDataGridColumnOrderChanged(scopeKey: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TableDataGridColumnOrderChangedDetail>(TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT, { detail: { scopeKey } }));
}

const FROZEN_STORAGE_PREFIX = "dbx-data-grid-frozen-columns:";

export interface DataGridColumnFrozenState {
  frozenCount: number;
  orderBeforeFreeze: string[] | null;
}

export function loadDataGridColumnFrozenState(scopeKey: string): DataGridColumnFrozenState {
  const emptyState = { frozenCount: 0, orderBeforeFreeze: null };
  const raw = safeLocalStorageGet(`${FROZEN_STORAGE_PREFIX}${scopeKey}`);
  if (!raw) return emptyState;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "number") return { frozenCount: parsed, orderBeforeFreeze: null };
    if (typeof parsed !== "object" || parsed === null || !("frozenCount" in parsed)) return emptyState;
    const frozenCount = typeof parsed.frozenCount === "number" ? parsed.frozenCount : 0;
    const orderBeforeFreeze = Array.isArray(parsed.orderBeforeFreeze) ? parsed.orderBeforeFreeze.filter((key: unknown): key is string => typeof key === "string") : null;
    return { frozenCount, orderBeforeFreeze };
  } catch {
    return emptyState;
  }
}

export function loadDataGridColumnFrozenCount(scopeKey: string): number {
  return loadDataGridColumnFrozenState(scopeKey).frozenCount;
}

export function saveDataGridColumnFrozenCount(scopeKey: string, frozenCount: number, orderBeforeFreeze: readonly string[] | null = null) {
  safeLocalStorageSet(`${FROZEN_STORAGE_PREFIX}${scopeKey}`, JSON.stringify({ version: STORAGE_VERSION, frozenCount, ...(orderBeforeFreeze ? { orderBeforeFreeze: [...orderBeforeFreeze] } : {}) }));
}

export function removeDataGridColumnFrozenCount(scopeKey: string) {
  safeLocalStorageRemove(`${FROZEN_STORAGE_PREFIX}${scopeKey}`);
}
