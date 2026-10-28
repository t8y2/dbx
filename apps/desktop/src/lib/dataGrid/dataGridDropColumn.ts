export interface DataGridDropColumnCandidate {
  name: string;
  primaryKey: boolean;
  protectedColumn: boolean;
}

export type DataGridDropColumnBlockReason = "unavailable" | "no-target" | "protected" | "primary-key" | "last-column" | "pending" | "busy" | "none";

export interface DataGridDropColumnToolbarState {
  visible: boolean;
  disabled: boolean;
  blockedReason: DataGridDropColumnBlockReason;
}

/** Same view check as `isViewTableType` in table editing: views have no DROP COLUMN target. */
export function isDataGridViewTable(tableType?: string): boolean {
  return tableType?.toUpperCase().includes("VIEW") === true;
}

/**
 * Column-header selection wins. A focused cell is the target only when no
 * column is selected, so a cell range does not drop every column it touches.
 */
export function dataGridDropColumnVisibleIndexes(selectedVisibleIndexes: readonly number[], focusVisibleIndex: number | null | undefined): number[] {
  const selected = [...new Set(selectedVisibleIndexes.filter((index) => Number.isInteger(index) && index >= 0))].sort((left, right) => left - right);
  if (selected.length > 0) return selected;
  if (typeof focusVisibleIndex === "number" && Number.isInteger(focusVisibleIndex) && focusVisibleIndex >= 0) return [focusVisibleIndex];
  return [];
}

export function dataGridDropColumnToolbarState(options: { available: boolean; busy: boolean; pendingChanges: boolean; tableColumnCount: number; targets: readonly DataGridDropColumnCandidate[] }): DataGridDropColumnToolbarState {
  if (!options.available) return { visible: false, disabled: true, blockedReason: "unavailable" };
  if (options.targets.length === 0) return { visible: true, disabled: true, blockedReason: "no-target" };
  if (options.targets.some((target) => target.protectedColumn)) return { visible: true, disabled: true, blockedReason: "protected" };
  if (options.targets.some((target) => target.primaryKey)) return { visible: true, disabled: true, blockedReason: "primary-key" };
  if (options.tableColumnCount > 0 && options.targets.length >= options.tableColumnCount) return { visible: true, disabled: true, blockedReason: "last-column" };
  if (options.pendingChanges) return { visible: true, disabled: true, blockedReason: "pending" };
  if (options.busy) return { visible: true, disabled: true, blockedReason: "busy" };
  return { visible: true, disabled: false, blockedReason: "none" };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Dialects whose quoted identifiers differ by case ("Foo" and "foo" are two columns). */
export function isDataGridColumnNameCaseSensitive(dialect: string | undefined): boolean {
  return dialect === "postgres" || dialect === "oracle" || dialect === "h2";
}

export function dataGridColumnNameKey(name: string, caseSensitive: boolean): string {
  return caseSensitive ? name : name.toLowerCase();
}

/** Attempted columns that are no longer in the server's column list. */
export function dataGridDroppedColumnNames(attempted: readonly string[], remaining: readonly string[], caseSensitive: boolean): string[] {
  const left = new Set(remaining.map((name) => dataGridColumnNameKey(name, caseSensitive)));
  return attempted.filter((name) => !left.has(dataGridColumnNameKey(name, caseSensitive)));
}

/** True when `sql` cites `column` as its own identifier, quoted or bare. */
export function dataGridSqlTextReferencesColumn(sql: string | undefined, column: string, caseSensitive = false): boolean {
  const text = sql ?? "";
  const name = column.trim();
  if (!text.trim() || !name) return false;
  const escaped = escapeRegExp(name);
  const quoted = `"${escaped}"|\`${escaped}\`|\\[${escaped}\\]`;
  // No lookbehind (unsupported by old WebViews): consume the preceding char instead.
  const bare = `(?:^|[^\\w$])${escaped}(?![\\w$])`;
  return new RegExp(`${quoted}|${bare}`, caseSensitive ? "" : "i").test(text);
}

/** True when a query fragment references any of the columns being dropped. */
export function dataGridSqlTextReferencesAnyColumn(sql: string | undefined, columns: readonly string[], caseSensitive = false): boolean {
  return columns.some((column) => dataGridSqlTextReferencesColumn(sql, column, caseSensitive));
}

export interface DataGridDropTarget {
  connectionId: string;
  database: string;
  schema: string;
  catalog: string;
  tableName: string;
}

interface DataGridDropTab {
  mode?: string;
  connectionId: string;
  database?: string;
  schema?: string;
  tableMeta?: { tableName: string; database?: string; schema?: string; catalog?: string };
  pendingDataChangeCount?: number;
  hasPendingDataEditorDraft?: boolean;
}

export function sameOptionalScope(left?: string, right?: string): boolean {
  const normalizedLeft = left?.trim() ?? "";
  const normalizedRight = right?.trim() ?? "";
  if (!normalizedLeft || !normalizedRight) return true;
  return normalizedLeft === normalizedRight;
}

/** Open data tabs (any pane) showing the table a drop targets. */
export function dataGridDropTargetTabs<T extends DataGridDropTab>(tabs: readonly T[], target: DataGridDropTarget): T[] {
  return tabs.filter((tab) => {
    const meta = tab.tableMeta;
    if (tab.mode !== "data" || tab.connectionId !== target.connectionId || !meta || meta.tableName !== target.tableName) return false;
    const tabDatabase = meta.database || tab.database;
    if (tabDatabase !== target.database && tab.database !== target.database) return false;
    return sameOptionalScope(meta.schema || tab.schema, target.schema) && sameOptionalScope(meta.catalog, target.catalog);
  });
}

/** A refresh of these tabs would discard unsaved rows or an open cell draft. */
export function dataGridDropTabsHavePending(tabs: readonly DataGridDropTab[]): boolean {
  return tabs.some((tab) => (tab.pendingDataChangeCount ?? 0) > 0 || tab.hasPendingDataEditorDraft === true);
}
