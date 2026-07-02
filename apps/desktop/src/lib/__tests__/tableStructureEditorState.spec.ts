import { describe, expect, it } from "vitest";
import { combineDataTypeForDatabase, createColumnDrafts, dataTypeLengthInputValue, isDataTypeLengthDisabled, isSqlServerIdentityCompatibleDataType, splitDataType } from "../tableStructureEditorState";

describe("tableStructureEditorState", () => {
  it("keeps mysql unsigned attributes in the editable base type", () => {
    expect(splitDataType("int(11) unsigned")).toEqual({ baseType: "int unsigned", params: "11" });
    expect(splitDataType("bigint(20) unsigned zerofill")).toEqual({
      baseType: "bigint unsigned zerofill",
      params: "20",
    });
  });

  it("combines mysql unsigned type choices with the length field", () => {
    expect(combineDataTypeForDatabase("mysql", "int unsigned", "11")).toBe("int(11) unsigned");
    expect(combineDataTypeForDatabase("mysql", "bigint unsigned zerofill", "20")).toBe("bigint(20) unsigned zerofill");
  });

  it("does not expose mysql enum or set values as editable length", () => {
    const dataType = "enum('purchase_in','sale_out','return_in','adjustment_out','transfer_in','transfer_out')";

    expect(splitDataType(dataType)).toEqual({
      baseType: "enum",
      params: "'purchase_in','sale_out','return_in','adjustment_out','transfer_in','transfer_out'",
    });
    expect(isDataTypeLengthDisabled("mysql", "enum")).toBe(true);
    expect(isDataTypeLengthDisabled("mysql", "set")).toBe(true);
    expect(dataTypeLengthInputValue("mysql", dataType)).toBe("");
    expect(dataTypeLengthInputValue("mysql", "set('manual','auto')")).toBe("");
  });

  it("strips SQL Server metadata parentheses from editable defaults", () => {
    const drafts = createColumnDrafts(
      [
        {
          name: "name",
          data_type: "nvarchar(100)",
          is_nullable: true,
          column_default: "('')",
          is_primary_key: false,
          extra: null,
        },
        {
          name: "active",
          data_type: "bit",
          is_nullable: false,
          column_default: "((1))",
          is_primary_key: false,
          extra: null,
        },
        {
          name: "created_at",
          data_type: "datetime2(7)",
          is_nullable: false,
          column_default: "((sysdatetime()))",
          is_primary_key: false,
          extra: null,
        },
        {
          name: "label",
          data_type: "nvarchar(100)",
          is_nullable: true,
          column_default: "('prefix (internal)')",
          is_primary_key: false,
          extra: null,
        },
      ],
      "sqlserver",
    );

    expect(drafts.map((draft) => draft.defaultValue)).toEqual(["''", "1", "sysdatetime()", "'prefix (internal)'"]);
    expect(drafts.map((draft) => draft.original?.column_default)).toEqual(["''", "1", "sysdatetime()", "'prefix (internal)'"]);
  });

  it("limits SQL Server identity columns to supported data types", () => {
    expect(isSqlServerIdentityCompatibleDataType("int")).toBe(true);
    expect(isSqlServerIdentityCompatibleDataType("bigint")).toBe(true);
    expect(isSqlServerIdentityCompatibleDataType("numeric(18, 0)")).toBe(true);
    expect(isSqlServerIdentityCompatibleDataType("decimal(10)")).toBe(true);
    expect(isSqlServerIdentityCompatibleDataType("varchar(255)")).toBe(false);
    expect(isSqlServerIdentityCompatibleDataType("numeric(18, 2)")).toBe(false);
  });
});
