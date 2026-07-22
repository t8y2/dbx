import type { Component } from "vue";

export type DataGridColumnMenuItem = {
  label: string;
  value: string;
  icon?: Component;
  disabled?: boolean;
  separatorBefore?: boolean;
  checked?: boolean;
};

export type DataGridContextMenuItem = {
  label: string;
  action?: () => void;
  disabled?: boolean | (() => boolean);
  separator?: boolean;
  icon?: Component;
  iconClass?: string;
  shortcut?: string;
  variant?: "default" | "destructive";
  visible?: boolean;
  children?: DataGridContextMenuItem[];
};

export type DataGridContextMenuIcons = {
  copy: Component;
  filter: Component;
  selection: Component;
  export: Component;
  database: Component;
  ascending: Component;
  descending: Component;
  clearSort: Component;
  cellDetails: Component;
  rowDetails: Component;
  columnDetails: Component;
  setNull: Component;
  bulkEdit: Component;
  transpose: Component;
  clone: Component;
  restore: Component;
  delete: Component;
};

export function createDataGridFilterSubmenu(options: {
  label: string;
  icon: Component;
  labels: Record<"equals" | "notEquals" | "like" | "notLike" | "lessThan" | "greaterThan" | "isNull" | "isNotNull" | "clear", string>;
  apply: (mode: "equals" | "not-equals" | "like" | "not-like" | "less-than" | "greater-than" | "is-null" | "is-not-null") => void;
  clear: () => void;
}): DataGridContextMenuItem {
  const { labels } = options;
  return {
    label: options.label,
    icon: options.icon,
    children: [
      { label: labels.equals, action: () => options.apply("equals") },
      { label: labels.notEquals, action: () => options.apply("not-equals") },
      { label: labels.like, action: () => options.apply("like") },
      { label: labels.notLike, action: () => options.apply("not-like") },
      { label: labels.lessThan, action: () => options.apply("less-than") },
      { label: labels.greaterThan, action: () => options.apply("greater-than") },
      { label: "", separator: true },
      { label: labels.isNull, action: () => options.apply("is-null") },
      { label: labels.isNotNull, action: () => options.apply("is-not-null") },
      { label: "", separator: true },
      { label: labels.clear, action: options.clear },
    ],
  };
}

export function createDataGridColumnContextMenuItems(options: {
  headerColumn: boolean;
  contextColumn: boolean;
  canCopyAlterSql: boolean;
  canFilter: boolean;
  hasSort: boolean;
  sortMode: "database" | "local";
  frozenColumnCount?: number;
  contextVisibleColIdx?: number;
  hasColumnSelection?: boolean;
  labels: Record<"copyName" | "copyNames" | "details" | "copyAlterSql" | "databaseAscending" | "databaseDescending" | "localAscending" | "localDescending" | "clearSort" | "freezeToColumn" | "freezeSelectedColumns" | "unfreezeColumns", string>;
  icons: Pick<DataGridContextMenuIcons, "copy" | "columnDetails" | "database" | "ascending" | "descending" | "clearSort">;
  actions: { copyName: () => void; copyNames: () => void; details: () => void; copyAlterSql: () => void; sort: (direction: "asc" | "desc" | null, mode: "database" | "local") => void; freezeToColumn: () => void; freezeSelectedColumns: () => void; unfreezeColumns: () => void };
  filterSubmenu: DataGridContextMenuItem;
}): DataGridContextMenuItem[] {
  const items: DataGridContextMenuItem[] = [];
  if (options.headerColumn) {
    items.push({ label: options.labels.copyName, action: options.actions.copyName, icon: options.icons.copy });
    items.push({ label: options.labels.copyNames, action: options.actions.copyNames, icon: options.icons.copy });
    items.push({ label: options.labels.details, action: options.actions.details, icon: options.icons.columnDetails });
    if (options.canCopyAlterSql) items.push({ label: options.labels.copyAlterSql, action: options.actions.copyAlterSql, icon: options.icons.copy });
  }
  if (!options.contextColumn && !options.headerColumn) return items;
  if (options.contextColumn) {
    items.push(
      { label: options.labels.databaseAscending, action: () => options.actions.sort("asc", "database"), icon: options.icons.database },
      { label: options.labels.databaseDescending, action: () => options.actions.sort("desc", "database"), icon: options.icons.database },
      { label: "", separator: true },
      { label: options.labels.localAscending, action: () => options.actions.sort("asc", "local"), icon: options.icons.ascending },
      { label: options.labels.localDescending, action: () => options.actions.sort("desc", "local"), icon: options.icons.descending },
    );
    if (options.hasSort) items.push({ label: options.labels.clearSort, action: () => options.actions.sort(null, options.sortMode), icon: options.icons.clearSort });
    if (options.canFilter) items.push({ label: "", separator: true }, options.filterSubmenu);
  }
  if (options.contextVisibleColIdx !== undefined) {
    items.push({ label: "", separator: true });
    if ((options.frozenColumnCount ?? 0) > 0) {
      items.push({ label: options.labels.unfreezeColumns, action: options.actions.unfreezeColumns });
    }
    if (options.hasColumnSelection) {
      items.push({ label: options.labels.freezeSelectedColumns, action: options.actions.freezeSelectedColumns });
    }
    items.push({ label: options.labels.freezeToColumn, action: options.actions.freezeToColumn });
  }
  return items;
}

export function createDataGridCellContextMenuItems(options: {
  hasCell: boolean;
  hasColumn: boolean;
  headerColumn: boolean;
  editable: boolean;
  hasCellSelection: boolean;
  hasEditableSelection: boolean;
  hasSelection: boolean;
  labels: Record<"cellDetails" | "columnDetails" | "rowDetails" | "setNull" | "bulkEdit" | "transpose", string>;
  icons: Pick<DataGridContextMenuIcons, "cellDetails" | "columnDetails" | "rowDetails" | "setNull" | "bulkEdit" | "transpose">;
  actions: Record<"cellDetails" | "columnDetails" | "rowDetails" | "setNull" | "bulkEdit" | "transpose", () => void>;
  downloadItem?: DataGridContextMenuItem | null;
  copySubmenu: DataGridContextMenuItem;
  selectionSubmenu: DataGridContextMenuItem;
  generateSubmenu?: DataGridContextMenuItem;
}): DataGridContextMenuItem[] {
  const items: DataGridContextMenuItem[] = [];
  if (options.hasCell) {
    if (options.hasColumn) {
      items.push({ label: options.labels.cellDetails, action: options.actions.cellDetails, icon: options.icons.cellDetails });
      if (options.downloadItem) items.push(options.downloadItem);
      items.push({ label: options.labels.columnDetails, action: options.actions.columnDetails, icon: options.icons.columnDetails });
    }
    items.push({ label: options.labels.rowDetails, action: options.actions.rowDetails, icon: options.icons.rowDetails }, { label: "", separator: true });
  }
  if (!options.headerColumn) items.push(options.copySubmenu);
  if (options.editable && options.hasCellSelection) {
    if (!options.headerColumn) items.push({ label: options.labels.setNull, action: options.actions.setNull, disabled: !options.hasEditableSelection, icon: options.icons.setNull });
    items.push({ label: options.labels.bulkEdit, action: options.actions.bulkEdit, disabled: !options.hasEditableSelection, icon: options.icons.bulkEdit });
    if (options.generateSubmenu) items.push(options.generateSubmenu);
  }
  if (options.hasCell) items.push({ label: options.labels.transpose, action: options.actions.transpose, icon: options.icons.transpose });
  if (options.hasSelection) items.push(options.selectionSubmenu);
  return items;
}

export function createDataGridRowContextMenuItems(options: {
  editable: boolean;
  hasRow: boolean;
  canClone: boolean;
  deleted: boolean;
  canDelete: boolean;
  labels: Record<"clone" | "restore" | "delete", string>;
  icons: Pick<DataGridContextMenuIcons, "clone" | "restore" | "delete">;
  actions: Record<"clone" | "restore" | "delete", () => void>;
}): DataGridContextMenuItem[] {
  if (!options.editable || !options.hasRow) return [];
  const items: DataGridContextMenuItem[] = [{ label: "", separator: true }];
  if (options.canClone) items.push({ label: options.labels.clone, action: options.actions.clone, icon: options.icons.clone });
  if (options.deleted) items.push({ label: options.labels.restore, action: options.actions.restore, icon: options.icons.restore });
  else if (options.canDelete) items.push({ label: options.labels.delete, action: options.actions.delete, icon: options.icons.delete, variant: "destructive" });
  items.push({ label: "", separator: true });
  return items;
}

export function createDataGridContextMenuItems(...groups: Array<readonly DataGridContextMenuItem[]>): DataGridContextMenuItem[] {
  return groups.flat();
}

export type DataGridColumnSortState = {
  column: string | null;
  columnIndex: number | null;
  direction: "asc" | "desc";
  mode: "database" | "local";
};

type SortMenuLabels = {
  databaseAscending: string;
  databaseDescending: string;
  currentPageAscending: string;
  currentPageDescending: string;
  clear: string;
};

type SortMenuIcons = {
  database: Component;
  ascending: Component;
  descending: Component;
  clear: Component;
};

export function dataGridColumnIsSorted(state: DataGridColumnSortState, column: string, columnIndex: number): boolean {
  return state.column === column && state.columnIndex === columnIndex;
}

export function dataGridSelectedSortMenuValue(state: DataGridColumnSortState, column: string, columnIndex: number): string | undefined {
  return dataGridColumnIsSorted(state, column, columnIndex) ? `${state.mode}-${state.direction}` : undefined;
}

export function createDataGridSortMenuItems(options: { column: string; columnIndex: number; state: DataGridColumnSortState; labels: SortMenuLabels; icons: SortMenuIcons }): DataGridColumnMenuItem[] {
  const { column, columnIndex, state, labels, icons } = options;
  const sorted = dataGridColumnIsSorted(state, column, columnIndex);
  return [
    { label: labels.databaseAscending, value: "database-asc", icon: icons.database, checked: sorted && state.direction === "asc" && state.mode === "database" },
    { label: labels.databaseDescending, value: "database-desc", icon: icons.database, checked: sorted && state.direction === "desc" && state.mode === "database" },
    { label: labels.currentPageAscending, value: "local-asc", icon: icons.ascending, checked: sorted && state.direction === "asc" && state.mode === "local", separatorBefore: true },
    { label: labels.currentPageDescending, value: "local-desc", icon: icons.descending, checked: sorted && state.direction === "desc" && state.mode === "local" },
    { label: labels.clear, value: "clear", icon: icons.clear, disabled: !sorted, separatorBefore: true },
  ];
}

export function createDataGridCompactColumnActionItems(options: {
  labels: { formatter: string; localFilter: string; serverFilter: string };
  icons: { formatter: Component; filter: Component; database: Component };
  formatterAvailable: boolean;
  serverFilterAvailable: boolean;
}): DataGridColumnMenuItem[] {
  const { labels, icons } = options;
  return [
    { label: labels.formatter, value: "formatter", icon: icons.formatter, disabled: !options.formatterAvailable },
    { label: labels.localFilter, value: "localFilter", icon: icons.filter },
    ...(options.serverFilterAvailable ? [{ label: labels.serverFilter, value: "serverFilter", icon: icons.database }] : []),
  ];
}
