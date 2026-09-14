import { describe, expect, it, vi } from "vitest";
import { createDataGridCellContextMenuItems, createDataGridColumnContextMenuItems, createDataGridCompactColumnActionItems, createDataGridFilterSubmenu, createDataGridRowContextMenuItems, createDataGridSortMenuItems, dataGridSelectedSortMenuValue } from "@/lib/dataGrid/dataGridContextMenu";

const icon = {};

describe("dataGridContextMenu", () => {
  it("marks only the active sort action and enables clear", () => {
    const state = { column: "id", columnIndex: 0, direction: "desc" as const, mode: "local" as const };
    const items = createDataGridSortMenuItems({
      column: "id",
      columnIndex: 0,
      state,
      labels: { databaseAscending: "db asc", databaseDescending: "db desc", currentPageAscending: "page asc", currentPageDescending: "page desc", clear: "clear" },
      icons: { database: icon, ascending: icon, descending: icon, clear: icon },
    });
    expect(items.map((item) => item.checked)).toEqual([false, false, false, true, undefined]);
    expect(items.at(-1)?.disabled).toBe(false);
    expect(dataGridSelectedSortMenuValue(state, "id", 0)).toBe("local-desc");
  });

  it("omits database sort entries from the sort menu when database sort is unsupported", () => {
    const state = { column: "id", columnIndex: 0, direction: "desc" as const, mode: "local" as const };
    const items = createDataGridSortMenuItems({
      column: "id",
      columnIndex: 0,
      state,
      databaseSortEnabled: false,
      labels: { databaseAscending: "db asc", databaseDescending: "db desc", currentPageAscending: "page asc", currentPageDescending: "page desc", clear: "clear" },
      icons: { database: icon, ascending: icon, descending: icon, clear: icon },
    });
    expect(items.map((item) => item.value)).toEqual(["local-asc", "local-desc", "clear"]);
    expect(items[0]?.separatorBefore).toBeFalsy();
    expect(dataGridSelectedSortMenuValue(state, "id", 0)).toBe("local-desc");
  });

  it("omits database sort entries from the column context menu when database sort is unsupported", () => {
    const action = vi.fn();
    const filter = createDataGridFilterSubmenu({
      label: "filter",
      icon,
      labels: { equals: "equals", notEquals: "not equals", like: "like", notLike: "not like", lessThan: "less", greaterThan: "greater", isNull: "null", isNotNull: "not null", clear: "clear" },
      apply: action,
      clear: action,
    });
    const items = createDataGridColumnContextMenuItems({
      headerColumn: false,
      contextColumn: true,
      canCopyAlterSql: false,
      canFilter: true,
      hasSort: true,
      sortMode: "database",
      databaseSortEnabled: false,
      labels: { copyName: "copy name", copyNames: "copy names", details: "details", copyAlterSql: "alter", databaseAscending: "db asc", databaseDescending: "db desc", localAscending: "local asc", localDescending: "local desc", clearSort: "clear sort" },
      icons: { copy: icon, columnDetails: icon, database: icon, ascending: icon, descending: icon, clearSort: icon },
      actions: { copyName: action, copyNames: action, details: action, copyAlterSql: action, sort: action },
      filterSubmenu: filter,
    });
    expect(items.map((item) => item.label)).toEqual(["local asc", "local desc", "clear sort", "", "filter"]);
  });

  it("omits unavailable server actions and disables unavailable formatter", () => {
    const items = createDataGridCompactColumnActionItems({
      labels: { formatter: "formatter", clearFormatter: "clear formatter", localFilter: "local", serverFilter: "server" },
      icons: { formatter: icon, clearFormatter: icon, filter: icon, database: icon },
      formatterAvailable: false,
      formatterActive: false,
      serverFilterAvailable: false,
    });
    expect(items.map((item) => item.value)).toEqual(["formatter", "localFilter", "clearFormatter"]);
    expect(items[0]?.disabled).toBe(true);
    expect(items[0]?.checked).toBe(false);
    expect(items.at(-1)).toMatchObject({ disabled: true, separatorBefore: true });
  });

  it("marks an active formatter and enables the compact clear action", () => {
    const items = createDataGridCompactColumnActionItems({
      labels: { formatter: "formatter", clearFormatter: "clear formatter", localFilter: "local", serverFilter: "server" },
      icons: { formatter: icon, clearFormatter: icon, filter: icon, database: icon },
      formatterAvailable: true,
      formatterActive: true,
      serverFilterAvailable: true,
    });
    expect(items[0]).toMatchObject({ value: "formatter", checked: true, disabled: false });
    expect(items.at(-1)).toMatchObject({ value: "clearFormatter", disabled: false, separatorBefore: true });
  });

  it("builds typed column, cell, and row capability groups", () => {
    const action = vi.fn();
    const filter = createDataGridFilterSubmenu({
      label: "filter",
      icon,
      labels: { equals: "equals", notEquals: "not equals", like: "like", notLike: "not like", lessThan: "less", greaterThan: "greater", isNull: "null", isNotNull: "not null", clear: "clear" },
      apply: action,
      clear: action,
    });
    const columnItems = createDataGridColumnContextMenuItems({
      headerColumn: true,
      contextColumn: true,
      canCopyAlterSql: true,
      canFilter: true,
      hasSort: true,
      sortMode: "database",
      labels: { copyName: "copy name", copyNames: "copy names", details: "details", copyAlterSql: "alter", databaseAscending: "db asc", databaseDescending: "db desc", localAscending: "local asc", localDescending: "local desc", clearSort: "clear sort" },
      icons: { copy: icon, columnDetails: icon, database: icon, ascending: icon, descending: icon, clearSort: icon },
      actions: { copyName: action, copyNames: action, details: action, copyAlterSql: action, sort: action },
      filterSubmenu: filter,
    });
    expect(columnItems.map((item) => item.label)).toContain("filter");

    const cellItems = createDataGridCellContextMenuItems({
      hasCell: true,
      hasColumn: true,
      headerColumn: false,
      editable: true,
      hasCellSelection: true,
      hasEditableSelection: false,
      hasSelection: true,
      labels: { cellDetails: "cell", columnDetails: "column", rowDetails: "row", setNull: "null", bulkEdit: "bulk", transpose: "transpose" },
      icons: { cellDetails: icon, columnDetails: icon, rowDetails: icon, setNull: icon, bulkEdit: icon, transpose: icon },
      actions: { cellDetails: action, columnDetails: action, rowDetails: action, setNull: action, bulkEdit: action, transpose: action },
      importItem: { label: "import" },
      downloadItem: { label: "download" },
      copySubmenu: { label: "copy" },
      clearSelectionItem: { label: "clear" },
    });
    expect(cellItems.slice(0, 4).map((item) => item.label)).toEqual(["cell", "import", "download", "column"]);
    expect(cellItems.find((item) => item.label === "bulk")?.disabled).toBe(true);

    const rowItems = createDataGridRowContextMenuItems({
      editable: true,
      hasRow: true,
      canClone: true,
      deleted: false,
      canDelete: true,
      labels: { clone: "clone", restore: "restore", delete: "delete" },
      icons: { clone: icon, restore: icon, delete: icon },
      actions: { clone: action, restore: action, delete: action },
    });
    expect(rowItems.find((item) => item.label === "delete")?.variant).toBe("destructive");
  });

  function columnMenuItems(overrides: { hasColumnSelection?: boolean; selectedColumnCount?: number; visibleColumnCount?: number; hiddenColumnCount?: number }) {
    const action = vi.fn();
    const filter = createDataGridFilterSubmenu({
      label: "filter",
      icon,
      labels: { equals: "equals", notEquals: "not equals", like: "like", notLike: "not like", lessThan: "less", greaterThan: "greater", isNull: "null", isNotNull: "not null", clear: "clear" },
      apply: action,
      clear: action,
    });
    return createDataGridColumnContextMenuItems({
      headerColumn: true,
      contextColumn: false,
      canCopyAlterSql: false,
      canFilter: false,
      hasSort: false,
      sortMode: "database",
      contextVisibleColIdx: 0,
      hasColumnSelection: false,
      selectedColumnCount: 1,
      visibleColumnCount: 3,
      hiddenColumnCount: 0,
      labels: {
        copyName: "copy name",
        copyNames: "copy names",
        details: "details",
        copyAlterSql: "alter",
        databaseAscending: "db asc",
        databaseDescending: "db desc",
        localAscending: "local asc",
        localDescending: "local desc",
        clearSort: "clear sort",
        freezeToColumn: "freeze to column",
        freezeSelectedColumns: "freeze selected",
        unfreezeColumns: "unfreeze",
        hideColumn: "hide column",
        hideSelectedColumns: "hide selected (3)",
        showAllColumnsMenu: "show all columns",
      },
      icons: { copy: icon, columnDetails: icon, database: icon, ascending: icon, descending: icon, clearSort: icon },
      actions: { copyName: action, copyNames: action, details: action, copyAlterSql: action, sort: action, freezeToColumn: action, freezeSelectedColumns: action, unfreezeColumns: action, hideColumn: action, hideSelectedColumns: action, showAllColumnsMenu: action },
      filterSubmenu: filter,
      ...overrides,
    });
  }

  it("offers hide-this-column on a header and hides the recovery entry until a column is hidden", () => {
    const labels = columnMenuItems({}).map((item) => item.label);

    expect(labels).toContain("hide column");
    expect(labels).not.toContain("hide selected (3)");
    expect(labels).not.toContain("show all columns");
  });

  it("offers batch hiding for a multi-column selection and shows the recovery entry when columns are hidden", () => {
    const items = columnMenuItems({ hasColumnSelection: true, selectedColumnCount: 3, visibleColumnCount: 5, hiddenColumnCount: 2 });
    const hideSelected = items.find((item) => item.label === "hide selected (3)");

    expect(hideSelected?.disabled).toBe(false);
    expect(items.map((item) => item.label)).toContain("show all columns");
  });

  it("disables batch hiding when the selection covers every visible column", () => {
    const items = columnMenuItems({ hasColumnSelection: true, selectedColumnCount: 3, visibleColumnCount: 3 });

    expect(items.find((item) => item.label === "hide selected (3)")?.disabled).toBe(true);
  });

  it("disables hiding this column when only one column is visible", () => {
    const items = columnMenuItems({ visibleColumnCount: 1 });
    const hideColumn = items.find((item) => item.label === "hide column");

    expect(hideColumn).toBeDefined();
    expect(hideColumn?.disabled).toBe(true);
  });

  it("keeps hiding this column enabled for callers that omit the visible column count", () => {
    const items = columnMenuItems({ visibleColumnCount: undefined });
    const hideColumn = items.find((item) => item.label === "hide column");

    expect(hideColumn).toBeDefined();
    expect(hideColumn?.disabled).toBe(false);
  });
});
