import { describe, expect, it } from "vitest";
import { clearDataGridStructuredFilterStates, loadDataGridStructuredFilterState, removeDataGridStructuredFilterColumnsForTab, saveDataGridStructuredFilterState } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";
import {
  dataGridDroppedColumnNames,
  dataGridDropColumnToolbarState,
  dataGridDropColumnVisibleIndexes,
  dataGridDropTabsHavePending,
  dataGridDropTargetTabs,
  dataGridSqlTextReferencesAnyColumn,
  dataGridSqlTextReferencesColumn,
  isDataGridColumnNameCaseSensitive,
  isDataGridViewTable,
} from "@/lib/dataGrid/dataGridDropColumn";

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

  it("matches bare names at the start, after punctuation, and case-sensitively when asked", () => {
    expect(dataGridSqlTextReferencesColumn("status", "status")).toBe(true);
    expect(dataGridSqlTextReferencesColumn("t.status = 1", "status")).toBe(true);
    expect(dataGridSqlTextReferencesColumn("$status = 1", "status")).toBe(false);
    expect(dataGridSqlTextReferencesColumn("STATUS = 1", "status")).toBe(true);
    expect(dataGridSqlTextReferencesColumn("STATUS = 1", "status", true)).toBe(false);
    expect(dataGridSqlTextReferencesColumn('"Foo" = 1', "foo", true)).toBe(false);
  });

  it("keeps quoted Foo and foo apart on case-sensitive dialects and reports partial success", () => {
    expect(isDataGridColumnNameCaseSensitive("postgres")).toBe(true);
    expect(isDataGridColumnNameCaseSensitive("mysql")).toBe(false);
    expect(dataGridDroppedColumnNames(["Foo", "foo"], ["foo"], true)).toEqual(["Foo"]);
    expect(dataGridDroppedColumnNames(["Foo", "foo"], ["foo"], false)).toEqual([]);
    expect(dataGridDroppedColumnNames(["a", "b", "c"], ["c"], false)).toEqual(["a", "b"]);
  });

  it("blocks on any open page of the table that has unsaved rows or a draft", () => {
    const target = { connectionId: "c1", database: "db", schema: "", catalog: "", tableName: "t" };
    const meta = { tableName: "t", database: "db" };
    const tabs = [
      { id: "a", mode: "data", connectionId: "c1", database: "db", tableMeta: meta },
      { id: "b", mode: "data", connectionId: "c1", database: "db", tableMeta: meta, pendingDataChangeCount: 2 },
      { id: "c", mode: "data", connectionId: "c1", database: "db", tableMeta: meta, hasPendingDataEditorDraft: true },
      { id: "d", mode: "data", connectionId: "c1", database: "db", tableMeta: { tableName: "other", database: "db" }, pendingDataChangeCount: 5 },
      { id: "e", mode: "data", connectionId: "c2", database: "db", tableMeta: meta, pendingDataChangeCount: 5 },
    ];
    const same = dataGridDropTargetTabs(tabs, target);
    expect(same.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
    expect(dataGridDropTabsHavePending(same)).toBe(true);
    expect(dataGridDropTabsHavePending([same[0]!])).toBe(false);
    expect(dataGridDropTabsHavePending([same[2]!])).toBe(true);
  });

  it("detects dropped columns in another tab's query inputs before refresh", () => {
    expect(dataGridSqlTextReferencesAnyColumn('status = 1 AND "archived" = 0', ["status", "archived"])).toBe(true);
    expect(dataGridSqlTextReferencesAnyColumn("status_code = 1", ["status"])).toBe(false);
  });

  it("removes dropped columns from cached structured filters", async () => {
    clearDataGridStructuredFilterStates();
    saveDataGridStructuredFilterState("tab-1", {
      scopeKey: "scope\u0001id\0status\0name",
      manualWhereInput: "status = 1",
      rules: [{ id: "r1", columnName: "status", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }],
      appliedWhereInput: "status = 1",
      serverColumnFilters: { 1: { condition: "status = 1", keys: ["1"], labels: ["1"] } },
    });
    await removeDataGridStructuredFilterColumnsForTab("tab-1", ["id", "status", "name"], ["status"], false, async () => "");
    expect(loadDataGridStructuredFilterState("tab-1", "scope\u0001id\0name")).toMatchObject({ manualWhereInput: "", rules: [], appliedWhereInput: "", serverColumnFilters: {} });
  });

  it("preserves remaining rules and remaps server filters after a partial drop", async () => {
    clearDataGridStructuredFilterStates();
    const state = {
      scopeKey: "connection\u0001db\u0001\u0001table-data\u0001\u0001t\u0001id\0status\0score",
      manualWhereInput: "id > 0",
      rules: ["status", "score"].map((columnName) => ({ id: columnName, columnName, mode: "equals" as const, rawValue: "1", rawEndValue: "", conjunction: "AND" as const })),
      appliedWhereInput: "status = 1 AND score = 1",
      serverColumnFilters: { 2: { condition: "score = 1", keys: ["1"], labels: ["1"] } },
    };
    saveDataGridStructuredFilterState("tab-a", state);
    saveDataGridStructuredFilterState("tab-b", state);
    const result = await removeDataGridStructuredFilterColumnsForTab("tab-a", ["id", "status", "score"], ["status"], false, async (rules) => rules.map((rule) => `${rule.columnName} = ${rule.rawValue}`).join(" AND "));
    expect(result).toMatchObject({ manualWhereInput: "id > 0", appliedWhereInput: "score = 1", rules: [{ columnName: "score" }], serverColumnFilters: { 1: state.serverColumnFilters[2] } });
    expect(loadDataGridStructuredFilterState("tab-a", state.scopeKey)).toBeUndefined();
    expect(loadDataGridStructuredFilterState("tab-a", result!.scopeKey)).toEqual(result);
    expect(loadDataGridStructuredFilterState("tab-b", state.scopeKey)).toEqual(state);
  });
});
