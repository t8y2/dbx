import { tokenIsIdentifier, tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";

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

/** Prune the generated predicates in a legacy applied WHERE whose rules were not recorded. */
export function removeDroppedColumnsFromStructuredWhere(where: string, droppedColumns: readonly string[], caseSensitive: boolean, dialectId = "mysql"): string {
  if (!where || !droppedColumns.length) return where;
  const dropped = new Set(droppedColumns.map((name) => dataGridColumnNameKey(name, caseSensitive)));
  const mysqlBackslashEscape = dialectId === "mysql" || dialectId === "doris";
  const tokens = tokenizeSqlSemantic(where, dialectId, { mysqlBackslashEscape }).filter((token) => token.kind !== "comment");
  if (!tokens.length) return where;

  const source = (from: number, to: number) => (from < to ? where.slice(tokens[from].span.start, tokens[to - 1].span.end) : "");
  function prune(from: number, to: number): string {
    if (from >= to) return "";
    const first = tokens[from];
    const original = source(from, to);
    const ands: number[] = [];
    const ors: number[] = [];
    let firstClosing = -1;
    let between = false;
    for (let index = from; index < to; index++) {
      const token = tokens[index];
      if (token.depth !== first.depth) continue;
      if (token.text === ")" && firstClosing < 0) firstClosing = index;
      if (token.kind !== "word") continue;
      if (token.normalized === "between") between = true;
      if (token.normalized === "and") {
        if (!between) ands.push(index);
        between = false;
      }
      if (token.normalized === "or") ors.push(index);
    }
    if (first.text === "(" && firstClosing === to - 1) {
      const inner = prune(from + 1, to - 1);
      return inner === source(from + 1, to - 1) ? original : inner;
    }

    // Split OR before AND to retain SQL precedence. A BETWEEN's AND belongs to
    // its predicate. The generated predicates start with the filtered column.
    const separators = ors.length ? ors : ands;
    if (!separators.length) {
      return tokenIsIdentifier(first) && dropped.has(dataGridColumnNameKey(unquoteSqlSemanticIdentifier(first), caseSensitive)) ? "" : original;
    }

    let changed = false;
    const retained: string[] = [];
    let start = from;
    for (const end of [...separators, to]) {
      const part = prune(start, end);
      if (part !== source(start, end)) changed = true;
      if (part) retained.push(part);
      start = end + 1;
    }
    if (!changed) return original;
    if (retained.length < 2) return retained[0] ?? "";
    return retained.map((part) => `(${part})`).join(ors.length ? " OR " : " AND ");
  }

  const pruned = prune(0, tokens.length);
  return pruned === source(0, tokens.length) ? where : pruned;
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
