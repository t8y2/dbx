import { describe, expect, it, vi } from "vitest";
import { applyTableDefaultSortResult, resolveTableDefaultSort } from "@/lib/table/tableDefaultSort";
import { editableRowIdentifierColumns, physicalTablePrimaryKeys } from "@/lib/table/tableEditing";
import type { ColumnInfo, QueryTab } from "@/types/database";

const settings = { tableOpenSortMode: "database", tableDatabaseSortDirection: "desc", tableLocalSortDirection: "asc" } as const;
const column: ColumnInfo = { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: false, extra: null };

describe("table default sorting", () => {
  it.each(["oracle", "oceanbase-oracle", "xugu", "neo4j"] as const)("preserves existing ordering for %s synthetic row identities in both modes", (databaseType) => {
    const keys = editableRowIdentifierColumns(databaseType, [column], [], "TABLE");
    expect(keys).toHaveLength(1);
    for (const tableOpenSortMode of ["database", "local"] as const) {
      const sort = resolveTableDefaultSort({ ...settings, tableOpenSortMode }, databaseType, physicalTablePrimaryKeys([column]));
      const tab = { id: "tab-1", result: { columns: keys, rows: [["2"], ["1"]] } } as QueryTab;
      const sortLocally = vi.fn();
      applyTableDefaultSortResult(tab, sort, sortLocally);
      expect(sort.orderBy).toBeUndefined();
      expect(sortLocally).not.toHaveBeenCalled();
      expect(tab.orderByInput).toBeUndefined();
      expect(tab.resultSortMode).toBeUndefined();
      expect(tab.result?.rows).toEqual([["2"], ["1"]]);
    }
  });

  it.each(["oracle", "neo4j"] as const)("still sorts real %s primary keys", (databaseType) => {
    const columns = [{ ...column, is_primary_key: true }];
    const sort = resolveTableDefaultSort(settings, databaseType, physicalTablePrimaryKeys(columns));
    expect(sort.orderBy).toBe(databaseType === "oracle" ? '"id" DESC' : "n.`id` DESC");
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("sorts %s primary indexes when column metadata omits the key flag", (databaseType) => {
    const columns = [{ ...column, name: "id" }];
    const sort = resolveTableDefaultSort(settings, databaseType, physicalTablePrimaryKeys(columns, [{ columns: ["id"], is_primary: true }]));
    expect(sort.orderBy).toBe('"id" DESC');
  });

  it("does not sort by a unique row identifier when the table lacks a physical primary key", () => {
    const columns = [{ ...column, name: "email" }];
    const rowIdentifiers = editableRowIdentifierColumns("postgres", columns, [{ name: "users_email_key", columns: ["email"], is_unique: true, is_primary: false, filter: null }]);
    expect(rowIdentifiers).toEqual(["email"]);

    const sort = resolveTableDefaultSort(settings, "postgres", physicalTablePrimaryKeys(columns));
    expect(sort.orderBy).toBeUndefined();
    expect(sort.columns).toEqual([]);
  });

  it("preserves composite ordering and escapes identifiers", () => {
    const sort = resolveTableDefaultSort(settings, "postgres", ['tenant"id', "id"]);
    expect(sort.orderBy).toBe('"tenant""id" DESC, "id" DESC');
    const tab = { id: "tab-1", result: { columns: ['tenant"id', "id"], rows: [] } } as unknown as QueryTab;
    applyTableDefaultSortResult(tab, sort, vi.fn());
    expect(tab.orderByInput).toBe(sort.orderBy);
    expect(tab.resultSortColumn).toBeUndefined();
  });
});
