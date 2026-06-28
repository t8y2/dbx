import { describe, expect, it } from "vitest";
import { combineDataTypeForDatabase, dataTypeLengthInputValue, isDataTypeLengthDisabled, splitDataType } from "../tableStructureEditorState";

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
});
