import { describe, expect, it } from "vitest";
import { combineDataTypeForDatabase, createColumnDrafts, createCopiedColumnDrafts, defaultNewColumnDataType, getDataTypeOptions, getDefaultLengthForType, isDataTypeLengthDisabled } from "@/lib/table/tableStructureEditorState";
import type { ColumnInfo } from "@/types/database";

describe.each(["oracle", "oceanbase-oracle"] as const)("%s numeric column fidelity", (databaseType) => {
  it.each([
    ["FLOAT", 63, null, "FLOAT(63)"],
    ["NUMBER", null, -2, "NUMBER(*,-2)"],
    ["NUMBER", 12, -2, "NUMBER(12,-2)"],
    ["NUMBER", null, 3, "NUMBER(*,3)"],
    ["NUMBER", null, 0, "NUMBER(*,0)"],
    ["NUMBER", 12, 0, "NUMBER(12,0)"],
    ["NUMBER", 12, null, "NUMBER(12)"],
    ["NUMBER", null, null, "NUMBER"],
    ["FLOAT", null, null, "FLOAT"],
    ["NUMBER(9,-3)", 9, -3, "NUMBER(9,-3)"],
    ["NUMBER(9,-3)", 12, 2, "NUMBER(9,-3)"],
  ])("retains %s precision %s and scale %s in edit and copy drafts", (dataType, precision, scale, expected) => {
    const metadata: ColumnInfo = {
      name: "AMOUNT",
      data_type: dataType as string,
      numeric_precision: precision as number | null,
      numeric_scale: scale as number | null,
      is_nullable: true,
      is_primary_key: false,
      column_default: null,
      extra: null,
    };
    const draft = createColumnDrafts([metadata], databaseType)[0];
    draft.comment = "updated comment";
    expect(draft.dataType).toBe(expected);
    expect(draft.original?.data_type).toBe(expected);
    expect(createCopiedColumnDrafts([metadata], databaseType, () => "copied")[0].dataType).toBe(expected);
  });

  it("allows editing FLOAT binary precision", () => {
    expect(isDataTypeLengthDisabled(databaseType, "FLOAT")).toBe(false);
  });

  it("selects FLOAT without a MySQL precision and scale default", () => {
    expect(getDefaultLengthForType(databaseType, "FLOAT")).toBe("");
    expect(combineDataTypeForDatabase(databaseType, "FLOAT", getDefaultLengthForType(databaseType, "FLOAT"))).toBe("FLOAT");
    expect(combineDataTypeForDatabase(databaseType, "FLOAT", "63")).toBe("FLOAT(63)");
  });
});

it("keeps MySQL FLOAT defaults and Dameng FLOAT input behavior", () => {
  expect(getDefaultLengthForType("mysql", "FLOAT")).toBe("10,2");
  expect(combineDataTypeForDatabase("mysql", "FLOAT", "10,2")).toBe("FLOAT(10,2)");
  expect(isDataTypeLengthDisabled("dameng", "FLOAT")).toBe(true);
});

describe("OceanBase Oracle built-in type recommendations", () => {
  it.each(["nclob", "long", "long raw", "bfile", "boolean", "vector"])("does not recommend %s rejected by OceanBase 4.2.5.7, while retaining Oracle's list", (type) => {
    expect(getDataTypeOptions("oceanbase-oracle")).not.toContain(type);
    expect(getDataTypeOptions("oracle")).toContain(type);
  });

  it("retains supported extended types and the existing default column type", () => {
    expect(getDataTypeOptions("oceanbase-oracle")).toEqual(expect.arrayContaining(["float", "json", "xmltype", "sdo_geometry", "rowid", "urowid"]));
    expect(defaultNewColumnDataType("oceanbase-oracle")).toBe("clob");
    expect(defaultNewColumnDataType("oracle")).toBe("clob");
  });

  it("preserves existing non-recommended types in edit and copy drafts", () => {
    const column: ColumnInfo = { name: "EXISTING_VALUE", data_type: "VECTOR(3, FLOAT32)", is_nullable: true, is_primary_key: false, column_default: null, extra: null };
    expect(createColumnDrafts([column], "oceanbase-oracle")[0].dataType).toBe(column.data_type);
    expect(createCopiedColumnDrafts([column], "oceanbase-oracle", () => "copy")[0].dataType).toBe(column.data_type);
  });
});
