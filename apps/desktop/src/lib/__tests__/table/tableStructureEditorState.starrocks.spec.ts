import { describe, expect, it } from "vitest";
import { tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { combineDataTypeForDatabase, dataTypeBaseInputValue, dataTypeLengthInputValue, defaultNewColumnDataType, getDataTypeOptions, getDefaultLengthForType, isDataTypeLengthDisabled } from "@/lib/table/tableStructureEditorState";

describe("StarRocks structure editor types", () => {
  it("uses native choices even when MySQL metadata supplies incompatible types", () => {
    const dbType = tableStructureDatabaseTypeForConnection({ db_type: "mysql", driver_profile: "starrocks" });
    expect(dbType).toBe("starrocks");
    const options = getDataTypeOptions(dbType, ["bigint unsigned", "timestamp", "enum", "text"], "3.5.0");
    expect(options).toEqual(getDataTypeOptions("starrocks", [], "3.5.0"));
    expect(options).toEqual(expect.arrayContaining(["bigint", "largeint", "datetime", "json", "array<int>", "map<int, int>", "struct<field int>", "bitmap", "hll", "percentile", "varbinary"]));
    expect(options.some((type) => /unsigned|timestamp|mediumint|text|blob|enum|^set$|geometry|^time$|^year$/i.test(type))).toBe(false);
    expect(defaultNewColumnDataType(dbType, options)).toBe("varchar(255)");
  });

  it.each(["BOOLEAN", "FLOAT", "DOUBLE", "DATE", "DATETIME", "STRING", "JSON", "BITMAP", "HLL", "PERCENTILE"])("does not add MySQL parameters to %s", (type) => {
    expect(isDataTypeLengthDisabled("starrocks", type)).toBe(true);
    expect(getDefaultLengthForType("starrocks", type)).toBe("");
    expect(combineDataTypeForDatabase("starrocks", type, "20")).toBe(type);
  });

  it.each([
    ["TINYINT", "4"],
    ["SMALLINT", "6"],
    ["INT", "11"],
    ["BIGINT", "20"],
    ["VARCHAR", "255"],
    ["CHAR", "1"],
    ["DECIMAL", "10,0"],
  ])("fills and displays the default parameter for %s", (type, length) => {
    expect(isDataTypeLengthDisabled("starrocks", type)).toBe(false);
    const defaultLength = getDefaultLengthForType("starrocks", type);
    expect(defaultLength).toBe(length);
    const dataType = combineDataTypeForDatabase("starrocks", type, defaultLength);
    expect(dataType).toBe(`${type}(${length})`);
    expect(dataTypeLengthInputValue("starrocks", dataType)).toBe(length);
  });

  it.each([
    ["VARCHAR", "255"],
    ["CHAR", "10"],
    ["BINARY", "16"],
    ["VARBINARY", "1024"],
    ["DECIMAL", "18,4"],
  ])("retains supported parameters for %s", (type, params) => {
    expect(isDataTypeLengthDisabled("starrocks", type)).toBe(false);
    expect(combineDataTypeForDatabase("starrocks", type, params)).toBe(`${type}(${params})`);
  });

  it.each(["ARRAY<DECIMAL(18,4)>", "MAP<VARCHAR(32), ARRAY<INT>>", "STRUCT<name VARCHAR(64), amount DECIMAL(18,2)>"])("preserves nested parameters in %s", (type) => {
    expect(dataTypeBaseInputValue("starrocks", type)).toBe(type);
    expect(dataTypeLengthInputValue("starrocks", type)).toBe("");
    expect(combineDataTypeForDatabase("starrocks", type, "255")).toBe(type);
  });

  it("keeps MySQL unsigned types, display widths and dynamic choices", () => {
    expect(getDataTypeOptions("mysql")).toContain("bigint unsigned");
    expect(getDataTypeOptions("mysql", [" custom_type ", "CUSTOM_TYPE"])[0]).toBe("custom_type");
    expect(getDataTypeOptions("mysql", [" custom_type ", "CUSTOM_TYPE"]).filter((type) => type.toLowerCase() === "custom_type")).toHaveLength(1);
    expect(combineDataTypeForDatabase("mysql", "bigint unsigned", "20")).toBe("bigint(20) unsigned");
    expect(getDefaultLengthForType("mysql", "bigint unsigned")).toBe("20");
  });
});

describe("StarRocks version capabilities", () => {
  it.each([
    [undefined, false, false, false, false],
    ["5.1.0", false, false, false, false],
    ["2.1.0", false, false, false, false],
    ["2.2.0", true, false, false, false],
    ["3.0.0", true, true, false, false],
    ["3.1.0", true, true, true, false],
    ["StarRocks version 3.5.0 abc123", true, true, true, false],
    ["4.0.0", true, true, true, true],
  ])("filters type choices for %s", (version, json, binary, complex, decimal256) => {
    const types = getDataTypeOptions("starrocks", [], version as string | undefined);
    expect(types.includes("json")).toBe(json);
    expect(types.includes("varbinary")).toBe(binary);
    expect(types.includes("map<int, int>")).toBe(complex);
    expect(types.includes("struct<field int>")).toBe(complex);
    expect(types.includes("decimal256")).toBe(decimal256);
  });
});
