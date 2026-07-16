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

  it("omits unavailable server actions and disables unavailable formatter", () => {
    const items = createDataGridCompactColumnActionItems({
      labels: { formatter: "formatter", localFilter: "local", serverFilter: "server" },
      icons: { formatter: icon, filter: icon, database: icon },
      formatterAvailable: false,
      serverFilterAvailable: false,
    });
    expect(items.map((item) => item.value)).toEqual(["formatter", "localFilter"]);
    expect(items[0]?.disabled).toBe(true);
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
      copySubmenu: { label: "copy" },
      selectionSubmenu: { label: "selection" },
    });
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
});
