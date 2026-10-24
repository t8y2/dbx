import { describe, expect, it } from "vitest";
import { dataGridDropColumnToolbarState, dataGridDropColumnVisibleIndexes, dataGridSqlTextReferencesColumn, isDataGridViewTable } from "@/lib/dataGrid/dataGridDropColumn";

const status = { name: "status", primaryKey: false, protectedColumn: false };

describe("data grid drop column", () => {
  it("treats view table types as views", () => {
    expect(isDataGridViewTable("VIEW")).toBe(true);
    expect(isDataGridViewTable("MATERIALIZED VIEW")).toBe(true);
    expect(isDataGridViewTable("BASE TABLE")).toBe(false);
    expect(isDataGridViewTable(undefined)).toBe(false);
  });

  it("uses the selected columns, otherwise the focused column", () => {
    expect(dataGridDropColumnVisibleIndexes([2, 0, 2], 4)).toEqual([0, 2]);
    expect(dataGridDropColumnVisibleIndexes([], 3)).toEqual([3]);
    expect(dataGridDropColumnVisibleIndexes([-1], null)).toEqual([]);
  });

  it("hides the action outside a droppable table and blocks unsafe targets", () => {
    expect(dataGridDropColumnToolbarState({ available: false, busy: false, pendingChanges: false, tableColumnCount: 3, targets: [status] }).visible).toBe(false);
    expect(dataGridDropColumnToolbarState({ available: true, busy: false, pendingChanges: false, tableColumnCount: 3, targets: [] }).blockedReason).toBe("no-target");
    expect(dataGridDropColumnToolbarState({ available: true, busy: false, pendingChanges: false, tableColumnCount: 3, targets: [{ ...status, protectedColumn: true }] }).blockedReason).toBe("protected");
    expect(dataGridDropColumnToolbarState({ available: true, busy: false, pendingChanges: false, tableColumnCount: 3, targets: [{ ...status, primaryKey: true }] }).blockedReason).toBe("primary-key");
    expect(dataGridDropColumnToolbarState({ available: true, busy: false, pendingChanges: false, tableColumnCount: 1, targets: [status] }).blockedReason).toBe("last-column");
    expect(dataGridDropColumnToolbarState({ available: true, busy: false, pendingChanges: true, tableColumnCount: 3, targets: [status] }).blockedReason).toBe("pending");
    expect(dataGridDropColumnToolbarState({ available: true, busy: true, pendingChanges: false, tableColumnCount: 3, targets: [status] })).toEqual({ visible: true, disabled: true, blockedReason: "busy" });
    expect(dataGridDropColumnToolbarState({ available: true, busy: false, pendingChanges: false, tableColumnCount: 3, targets: [status, { name: "note", primaryKey: false, protectedColumn: false }] })).toEqual({
      visible: true,
      disabled: false,
      blockedReason: "none",
    });
  });

  it("matches a column identifier without matching a longer name", () => {
    expect(dataGridSqlTextReferencesColumn("gid = 1 AND status = 'open'", "gid")).toBe(true);
    expect(dataGridSqlTextReferencesColumn("`status` IS NULL", "status")).toBe(true);
    expect(dataGridSqlTextReferencesColumn("[status] > 0", "status")).toBe(true);
    expect(dataGridSqlTextReferencesColumn("user_id = 1", "id")).toBe(false);
    expect(dataGridSqlTextReferencesColumn("status_code = 1", "status")).toBe(false);
    expect(dataGridSqlTextReferencesColumn("", "status")).toBe(false);
  });
});
