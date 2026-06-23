import { describe, expect, it } from "vitest";
import { DBX_ROWID_COLUMN, canUseKeylessRowPredicate, editablePrimaryKeys, editableRowIdentifierColumns, isTableDataEditable } from "@/lib/tableEditing";
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
});
