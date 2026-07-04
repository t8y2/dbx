import { describe, expect, it } from "vitest";
import { DBX_ROWID_COLUMN, canEditExistingTableRows, canUseKeylessRowPredicate, editablePrimaryKeys, editableRowIdentifierColumns, isClickHouseExistingRowReadonlyColumn, isTableDataEditable, supportsDataGridTransaction, usesSyntheticRowIdKey } from "@/lib/table/tableEditing";
import type { ColumnInfo, IndexInfo } from "@/types/database";

function column(name: string, isPrimaryKey = false): ColumnInfo {
  return {
    name,
    data_type: "varchar",
    is_nullable: true,
    column_default: null,
    is_primary_key: isPrimaryKey,
    extra: null,
  };
}

function index(columns: string[], isUnique = true, filter: string | null = null): IndexInfo {
  return {
    name: columns.join("_"),
    columns,
    is_unique: isUnique,
    is_primary: false,
    filter,
  };
}

describe("tableEditing", () => {
  it("does not synthesize Oracle ROWID for views", () => {
    expect(editablePrimaryKeys("oracle", [column("ID"), column("NAME")], "VIEW")).toEqual([]);
    expect(editablePrimaryKeys("oracle", [column("ID"), column("NAME")], "TABLE")).toEqual([DBX_ROWID_COLUMN]);
  });

  it("treats view data tabs as readonly", () => {
    expect(isTableDataEditable("oracle", [DBX_ROWID_COLUMN], "VIEW")).toBe(false);
  });

  it("does not include Oracle ROWID for view data tabs", () => {
    expect(usesSyntheticRowIdKey("oracle", [DBX_ROWID_COLUMN], "VIEW")).toBe(false);
    expect(usesSyntheticRowIdKey("oracle", [DBX_ROWID_COLUMN], "MATERIALIZED_VIEW")).toBe(false);
  });

  it("allows keyless row predicates only for databases that support them", () => {
    expect(canUseKeylessRowPredicate("postgres", [])).toBe(true);
    expect(canUseKeylessRowPredicate("mysql", [])).toBe(true);
    expect(canUseKeylessRowPredicate("jdbc", [])).toBe(false);
    expect(canUseKeylessRowPredicate("postgres", ["id"])).toBe(false);
  });

  it("uses unique indexes as row identifiers when primary keys are absent", () => {
    expect(editableRowIdentifierColumns("postgres", [column("email"), column("name")], [index(["email", "name"]), index(["email"])])).toEqual(["email"]);
    expect(editableRowIdentifierColumns("postgres", [column("email"), column("name")], [index(["email"], true, "email IS NOT NULL")])).toEqual([]);
    expect(editableRowIdentifierColumns("postgres", [column("id", true), column("email")], [index(["email"])])).toEqual(["id"]);
  });

  it("allows ClickHouse table editing when row identifiers are available", () => {
    expect(isTableDataEditable("clickhouse", ["id"], "BASE TABLE")).toBe(true);
    expect(canEditExistingTableRows("clickhouse", undefined, ["id"])).toBe(true);
    expect(supportsDataGridTransaction("clickhouse")).toBe(false);
    expect(isTableDataEditable("clickhouse", [], "BASE TABLE")).toBe(true);
    expect(canEditExistingTableRows("clickhouse", undefined, [])).toBe(false);
  });

  it("treats ClickHouse row identifier cells as readonly on existing rows", () => {
    expect(isClickHouseExistingRowReadonlyColumn("clickhouse", "ID", ["id"])).toBe(true);
    expect(isClickHouseExistingRowReadonlyColumn("clickhouse", "name", ["id"])).toBe(false);
    expect(isClickHouseExistingRowReadonlyColumn("clickhouse", "event_date", ["id"], [{ ...column("event_date"), extra: "partition_key" }])).toBe(true);
    expect(isClickHouseExistingRowReadonlyColumn("postgres", "id", ["id"])).toBe(false);
  });
});
