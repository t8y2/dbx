import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { DatabaseType } from "@/types/database";

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
  databaseType?: DatabaseType;
  columns: readonly string[];
  sourceColumns?: readonly (string | undefined)[];
}

export interface DataGridColumnLayout {
  orderKeys: string[];
  hiddenKeys: string[];
}

interface StoredDataGridColumnLayout extends DataGridColumnLayout {
  version: number;
}

interface LegacyStoredDataGridColumnLayout {
  version: number;
  columnSignature?: string;
  order: string[];
}

export interface DocumentDataGridColumnLayoutScope {
  databaseType: DatabaseType;
  connectionId: string;
  database: string;
  collection: string;
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
  // The database column order the arrangement was made against. Entries saved
  // before this field existed carry none and are applied unconditionally.
  baseOrder?: string[];
}

function sameRelativeOrder(left: readonly string[], right: readonly string[]): boolean {
  const leftKeys = new Set(left);
  const shared = new Set(right.filter((key) => leftKeys.has(key)));
  const leftShared = left.filter((key) => shared.has(key));
  const rightShared = right.filter((key) => shared.has(key));
  return leftShared.every((key, index) => key === rightShared[index]);
}

function normalizeSql(sql?: string): string {
  return (sql ?? "").replace(/\s+/g, " ").trim();
}

function queryLayoutSql(sql: string, databaseType?: DatabaseType): string {
  const dialect = sqlSemanticDialectFor({ databaseType }).id;
  const mysql = dialect === "mysql" || dialect === "doris";
  const tokens = tokenizeSqlSemantic(sql, dialect, { mysqlDashCommentRequiresWhitespace: mysql, mysqlBackslashEscape: mysql }).filter((token) => token.depth === 0 && token.kind !== "comment");
  if (tokens[0]?.normalized !== "select" && tokens[0]?.normalized !== "with") return sql;
  if (tokens.some((token, index) => (token.text === ";" && index !== tokens.length - 1) || (token.kind === "word" && ["union", "intersect", "except", "minus"].includes(token.normalized)))) return sql;
  const from = tokens.findIndex((token) => token.kind === "word" && token.normalized === "from");
  if (from === -1) return sql;
  const where = tokens.findIndex((token, index) => index > from && token.kind === "word" && token.normalized === "where");
  if (where === -1) return sql;
  const end = tokens.find((token, index) => {
    if (index <= where) return false;
    if (token.text === ";") return true;
    if (token.kind !== "word" || tokens[index - 1]?.text === "." || tokens[index + 1]?.text === ".") return false;
    if (token.normalized === "group" || token.normalized === "order") return tokens[index + 1]?.normalized === "by";
    return ["having", "window", "qualify", "limit", "offset", "fetch", "for", "option", "settings", "format", "returning"].includes(token.normalized);
  });
  return `${sql.slice(0, tokens[where]!.span.start)}WHERE${end ? ` ${sql.slice(end.span.start)}` : ""}`;
}

export function dataGridColumnLayoutScopeKey(scope: DataGridColumnLayoutScope, preserveFilter = false): string {
  const columnSignature = scope.columns.join("\0");
  const sourceSignature = (scope.sourceColumns ?? []).map((column) => column ?? "").join("\0");
  const sql = scope.context === "results" && scope.sql && !scope.tableName && !preserveFilter ? queryLayoutSql(scope.sql, scope.databaseType) : scope.sql;
  return [scope.connectionId ?? "", scope.database ?? "", scope.schema ?? "", scope.context ?? "", scope.tableSchema ?? "", scope.tableName ?? "", scope.tableName ? "" : normalizeSql(sql), columnSignature, sourceSignature].join("\u0001");
}

export function migrateDataGridColumnLayout(scopeKey: string, previousScopeKey: string, columnKeys: readonly string[]): DataGridColumnLayout | null {
  const existing = loadDataGridColumnLayout(scopeKey, columnKeys);
  if (existing || scopeKey === previousScopeKey) return existing;
  const previous = loadDataGridColumnLayout(previousScopeKey, columnKeys);
  const frozen = loadDataGridColumnFrozenState(previousScopeKey);
  if (!previous && frozen.frozenCount === 0) return null;
  const layout = previous ?? { orderKeys: [], hiddenKeys: [] };
  saveDataGridColumnLayout(scopeKey, layout);
  if (frozen.frozenCount > 0) saveDataGridColumnFrozenCount(scopeKey, frozen.frozenCount, frozen.orderBeforeFreeze);
  return layout;
}

export function documentDataGridColumnLayoutScopeKey(scope: DocumentDataGridColumnLayoutScope): string {
  return ["document", scope.databaseType, scope.connectionId, scope.database, scope.collection].join("\u0001");
}

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === "string"))];
}

export function loadDataGridColumnLayout(scopeKey: string, columnKeys: readonly string[] = []): DataGridColumnLayout | null {
  const raw = safeLocalStorageGet(`${STORAGE_PREFIX}${scopeKey}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDataGridColumnLayout & LegacyStoredDataGridColumnLayout>;
    if (parsed.version !== STORAGE_VERSION) return null;
    if (Array.isArray(parsed.orderKeys) || Array.isArray(parsed.hiddenKeys)) {
      return {
        orderKeys: normalizedStringList(parsed.orderKeys),
        hiddenKeys: normalizedStringList(parsed.hiddenKeys),
      };
    }
    if (!Array.isArray(parsed.order)) return null;
    if (parsed.columnSignature && parsed.columnSignature !== columnKeys.join("\0")) return null;
    return { orderKeys: normalizedStringList(parsed.order), hiddenKeys: [] };
  } catch (error) {
    console.warn(`[DBX][data-grid-column-layout:parse] ${scopeKey}`, error);
    return null;
  }
}

export function saveDataGridColumnLayout(scopeKey: string, layout: DataGridColumnLayout) {
  const payload: StoredDataGridColumnLayout = {
    version: STORAGE_VERSION,
    orderKeys: normalizedStringList(layout.orderKeys),
    hiddenKeys: normalizedStringList(layout.hiddenKeys),
  };
  safeLocalStorageSet(`${STORAGE_PREFIX}${scopeKey}`, JSON.stringify(payload));
}

export function loadDataGridColumnOrder(scopeKey: string, columnKeys: readonly string[]): string[] {
  return loadDataGridColumnLayout(scopeKey, columnKeys)?.orderKeys ?? [];
}

export function saveDataGridColumnOrder(scopeKey: string, columnKeys: readonly string[], order: readonly string[]) {
  const hiddenKeys = loadDataGridColumnLayout(scopeKey, columnKeys)?.hiddenKeys ?? [];
  saveDataGridColumnLayout(scopeKey, { orderKeys: [...order], hiddenKeys });
}

export function removeDataGridColumnOrder(scopeKey: string) {
  const layout = loadDataGridColumnLayout(scopeKey);
  if (!layout) {
    safeLocalStorageRemove(`${STORAGE_PREFIX}${scopeKey}`);
    return;
  }
  saveDataGridColumnLayout(scopeKey, { orderKeys: [], hiddenKeys: layout.hiddenKeys });
}

export function tableDataGridColumnOrderScopeKey(scope: TableDataGridColumnOrderScope): string {
  const namespace = scope.schema?.trim() || scope.database;
  return [scope.connectionId, scope.database, namespace, scope.tableName].join("\u0001");
}

/**
 * Returns the table's shared column order, or `null` when the table has no
 * entry at all. Pass the table's current database column order as
 * `databaseOrder` to discard an arrangement made against a different physical
 * order: once the table is rebuilt with its columns in a new order, the saved
 * arrangement no longer reflects what the user chose and would hide the new
 * database order. The discarded entry is replaced by an empty order rather than
 * removed, so every view sharing the table learns that the database order now
 * applies, whichever view notices the rebuild first.
 */
export function loadTableDataGridColumnOrderEntry(scopeKey: string, databaseOrder?: readonly string[]): string[] | null {
  const raw = safeLocalStorageGet(`${TABLE_STORAGE_PREFIX}${scopeKey}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTableDataGridColumnOrder>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.order)) return null;
    if (databaseOrder?.length && Array.isArray(parsed.baseOrder) && !sameRelativeOrder(parsed.baseOrder, databaseOrder)) {
      saveTableDataGridColumnOrder(scopeKey, [], databaseOrder);
      return [];
    }
    return parsed.order.filter((key): key is string => typeof key === "string");
  } catch {
    return null;
  }
}

export function loadTableDataGridColumnOrder(scopeKey: string, databaseOrder?: readonly string[]): string[] {
  return loadTableDataGridColumnOrderEntry(scopeKey, databaseOrder) ?? [];
}

export function saveTableDataGridColumnOrder(scopeKey: string, order: readonly string[], baseOrder?: readonly string[]) {
  const payload: StoredTableDataGridColumnOrder = {
    version: STORAGE_VERSION,
    order: [...order],
    ...(baseOrder?.length ? { baseOrder: [...baseOrder] } : {}),
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
