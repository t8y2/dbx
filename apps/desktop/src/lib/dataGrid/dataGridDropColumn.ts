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

/** True when `sql` cites `column` as its own identifier, quoted or bare. */
export function dataGridSqlTextReferencesColumn(sql: string | undefined, column: string): boolean {
  const text = sql ?? "";
  const name = column.trim();
  if (!text.trim() || !name) return false;
  const escaped = escapeRegExp(name);
  const quoted = `(?:"${escaped}"|\`${escaped}\`|\\[${escaped}\\])`;
  const bare = `(?<![\\w$])${escaped}(?![\\w$])`;
  return new RegExp(`${quoted}|${bare}`, "i").test(text);
}
