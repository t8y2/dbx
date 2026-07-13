import { describe, expect, it } from "vitest";
import {
  combineDataTypeForDatabase,
  combineDataTypeForDatabaseWithLengthUnit,
  createColumnDrafts,
  dataTypeLengthInputValue,
  dataTypeLengthUnitValue,
  DATA_TYPE_OPTIONS,
  defaultNewColumnDataType,
  getDataTypeLengthUnitOptions,
  getDefaultLengthForType,
  hasExistingColumnTypeChange,
  isDataTypeLengthDisabled,
  isDamengIdentityCompatibleDataType,
  isMysqlCharacterDataType,
  isMysqlEnumDataType,
  isSqlServerIdentityCompatibleDataType,
  mysqlEnumDataType,
  rehydrateColumnDraftsFromMetadata,
  restoreDamengLengthUnitsAfterSave,
  splitDataType,
} from "@/lib/table/tableStructureEditorState";

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

  it("hydrates mysql enum values into an editable canonical type", () => {
    const [draft] = createColumnDrafts(
      [
        {
          name: "status",
          data_type: "enum",
          enum_values: ["", "pending", "it's", "path\\name"],
          is_nullable: false,
          column_default: "'pending'",
          is_primary_key: false,
          extra: null,
        },
      ],
      "mysql",
    );

    expect(draft?.enumValues).toEqual(["", "pending", "it's", "path\\name"]);
    expect(draft?.dataType).toBe("enum('','pending','it''s','path\\\\name')");
    expect(draft?.original?.data_type).toBe(draft?.dataType);
  });

  it("builds mysql enum types without confusing values with length", () => {
    expect(isMysqlEnumDataType("mysql", "ENUM('a','b')")).toBe(true);
    expect(isMysqlEnumDataType("postgres", "enum")).toBe(false);
    expect(mysqlEnumDataType(["", "a'b", "a\\b"])).toBe("enum('','a''b','a\\\\b')");
  });

  it("rehydrates enum values into drafts saved before enum editing existed", () => {
    const metadata = {
      name: "status",
      data_type: "enum",
      enum_values: ["pending", "active"],
      is_nullable: false,
      column_default: "'pending'",
      is_primary_key: false,
      extra: null,
    };
    const [legacyDraft] = createColumnDrafts([metadata], "mysql");
    legacyDraft!.dataType = "enum";
    legacyDraft!.enumValues = undefined;
    legacyDraft!.original = { ...metadata };

    const [rehydrated] = rehydrateColumnDraftsFromMetadata([legacyDraft!], [metadata], "mysql");

    expect(rehydrated?.enumValues).toEqual(["pending", "active"]);
    expect(rehydrated?.dataType).toBe("enum('pending','active')");
    expect(rehydrated?.original?.data_type).toBe("enum('pending','active')");
  });

  it("does not expose Oracle-like integer display widths as editable length", () => {
    expect(isDataTypeLengthDisabled("dameng", "integer")).toBe(true);
    expect(dataTypeLengthInputValue("dameng", "integer(11)")).toBe("");
    expect(combineDataTypeForDatabase("dameng", "integer", "11")).toBe("integer");
    expect(combineDataTypeForDatabase("oracle", "number", "10,0")).toBe("number(10,0)");
    expect(combineDataTypeForDatabase("mysql", "integer", "11")).toBe("integer(11)");
  });

  it("offers BYTE and CHAR units only for supported Dameng character types", () => {
    expect(getDataTypeLengthUnitOptions("dameng", "varchar2(255 CHAR)")).toEqual(["BYTE", "CHAR"]);
    expect(getDataTypeLengthUnitOptions("dameng", "varchar(255)")).toEqual(["BYTE", "CHAR"]);
    expect(getDataTypeLengthUnitOptions("dameng", "char(10 BYTE)")).toEqual(["BYTE", "CHAR"]);

    expect(getDataTypeLengthUnitOptions("dameng", "nchar(10)")).toEqual([]);
    expect(getDataTypeLengthUnitOptions("dameng", "nvarchar2(10)")).toEqual([]);
    expect(getDataTypeLengthUnitOptions("dameng", "number(10,0)")).toEqual([]);
    expect(getDataTypeLengthUnitOptions("oracle", "varchar2(255 CHAR)")).toEqual([]);
    expect(getDataTypeLengthUnitOptions("mysql", "varchar(255)")).toEqual([]);
  });

  it("separates and reconstructs Dameng character length units", () => {
    expect(dataTypeLengthInputValue("dameng", "varchar2(255 char)")).toBe("255");
    expect(dataTypeLengthUnitValue("dameng", "varchar2(255 char)")).toBe("CHAR");
    expect(dataTypeLengthInputValue("dameng", "char(10 BYTE)")).toBe("10");
    expect(dataTypeLengthUnitValue("dameng", "char(10 BYTE)")).toBe("BYTE");

    expect(combineDataTypeForDatabaseWithLengthUnit("dameng", "varchar2", "255", "CHAR")).toBe("varchar2(255 CHAR)");
    expect(combineDataTypeForDatabaseWithLengthUnit("dameng", "varchar", "64", "byte")).toBe("varchar(64 BYTE)");
    expect(combineDataTypeForDatabaseWithLengthUnit("dameng", "char", "", "CHAR")).toBe("char");
    expect(combineDataTypeForDatabaseWithLengthUnit("dameng", "varchar2", "255", "")).toBe("varchar2(255)");
  });

  it("does not reinterpret unsupported length parameters or dialects", () => {
    expect(dataTypeLengthInputValue("dameng", "varchar2(255 WORD)")).toBe("255 WORD");
    expect(dataTypeLengthUnitValue("dameng", "varchar2(255 WORD)")).toBe("");
    expect(combineDataTypeForDatabaseWithLengthUnit("mysql", "varchar", "255", "CHAR")).toBe("varchar(255)");
    expect(combineDataTypeForDatabaseWithLengthUnit("dameng", "nvarchar2", "20", "BYTE")).toBe("nvarchar2(20)");
  });

  it("keeps a saved Dameng length unit when an older agent omits it during post-save refresh", () => {
    const [legacyAgentDraft] = createColumnDrafts(
      [
        {
          name: "DISPLAY_NAME",
          data_type: "VARCHAR2(255)",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: null,
        },
      ],
      "dameng",
    );

    const [restored] = restoreDamengLengthUnitsAfterSave([legacyAgentDraft!], new Map([["display_name", "VARCHAR2(255 CHAR)"]]));

    expect(restored?.dataType).toBe("VARCHAR2(255 CHAR)");
    expect(restored?.original?.data_type).toBe("VARCHAR2(255 CHAR)");
  });

  it("prefers live Dameng metadata when the agent returns an explicit length unit", () => {
    const [liveDraft] = createColumnDrafts(
      [
        {
          name: "DISPLAY_NAME",
          data_type: "VARCHAR2(255 BYTE)",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: null,
        },
      ],
      "dameng",
    );

    const [restored] = restoreDamengLengthUnitsAfterSave([liveDraft!], new Map([["display_name", "VARCHAR2(255 CHAR)"]]));

    expect(restored?.dataType).toBe("VARCHAR2(255 BYTE)");
    expect(restored?.original?.data_type).toBe("VARCHAR2(255 BYTE)");
  });

  it("does not add MySQL display lengths when choosing SQLite-family types", () => {
    for (const databaseType of ["sqlite", "rqlite", "turso"] as const) {
      expect(getDefaultLengthForType(databaseType, "integer")).toBe("");
      expect(getDefaultLengthForType(databaseType, "real")).toBe("");
      expect(combineDataTypeForDatabase(databaseType, "integer", getDefaultLengthForType(databaseType, "integer"))).toBe("integer");
    }

    expect(getDefaultLengthForType("mysql", "integer")).toBe("11");
  });

  it("uses MySQL 8-safe defaults only when the native MySQL profile is known", () => {
    const mysql8Defaults = { omitMysqlDeprecatedDefaults: true };

    expect(getDefaultLengthForType("mysql", "int", mysql8Defaults)).toBe("");
    expect(getDefaultLengthForType("mysql", "bigint unsigned", mysql8Defaults)).toBe("");
    expect(getDefaultLengthForType("mysql", "float", mysql8Defaults)).toBe("");
    expect(getDefaultLengthForType("mysql", "double", mysql8Defaults)).toBe("");
    expect(combineDataTypeForDatabase("mysql", "int", getDefaultLengthForType("mysql", "int", mysql8Defaults))).toBe("int");
    expect(combineDataTypeForDatabase("mysql", "float", getDefaultLengthForType("mysql", "float", mysql8Defaults))).toBe("float");
    expect(getDefaultLengthForType("mysql", "decimal", mysql8Defaults)).toBe("10,0");

    // A compatibility profile cannot be version-identified, so its existing behavior is retained.
    expect(getDefaultLengthForType("mysql", "int")).toBe("11");
    expect(getDefaultLengthForType("mysql", "float")).toBe("10,2");
  });

  it("uses TEXT for a new native SQLite column without changing compatible defaults", () => {
    expect(DATA_TYPE_OPTIONS.sqlite).toContain("text");
    expect(defaultNewColumnDataType("sqlite")).toBe("text");
    expect(defaultNewColumnDataType("rqlite")).toBe("varchar(255)");
    expect(defaultNewColumnDataType("turso")).toBe("varchar(255)");
    expect(defaultNewColumnDataType("mysql")).toBe("varchar(255)");
  });

  it("requires a SQLite rebuild only for a retained existing column type change", () => {
    const [column] = createColumnDrafts(
      [
        {
          name: "status",
          data_type: "integer",
          is_nullable: false,
          column_default: null,
          is_primary_key: false,
          extra: null,
        },
      ],
      "sqlite",
    );

    expect(hasExistingColumnTypeChange([column])).toBe(false);
    column.name = "state";
    expect(hasExistingColumnTypeChange([column])).toBe(false);
    column.dataType = "text";
    expect(hasExistingColumnTypeChange([column])).toBe(true);
    column.markedForDrop = true;
    expect(hasExistingColumnTypeChange([column])).toBe(false);
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

  it("limits Dameng identity columns to supported data types", () => {
    expect(isDamengIdentityCompatibleDataType("int")).toBe(true);
    expect(isDamengIdentityCompatibleDataType("integer")).toBe(true);
    expect(isDamengIdentityCompatibleDataType("bigint")).toBe(true);
    expect(isDamengIdentityCompatibleDataType("number(18, 0)")).toBe(true);
    expect(isDamengIdentityCompatibleDataType("decimal(10)")).toBe(true);
    expect(isDamengIdentityCompatibleDataType("varchar(255)")).toBe(false);
    expect(isDamengIdentityCompatibleDataType("number(18, 2)")).toBe(false);
  });

  it("identifies MySQL character data types that accept charset/collation", () => {
    expect(isMysqlCharacterDataType("char(1)")).toBe(true);
    expect(isMysqlCharacterDataType("varchar(255)")).toBe(true);
    expect(isMysqlCharacterDataType("tinytext")).toBe(true);
    expect(isMysqlCharacterDataType("text")).toBe(true);
    expect(isMysqlCharacterDataType("mediumtext")).toBe(true);
    expect(isMysqlCharacterDataType("longtext")).toBe(true);
    expect(isMysqlCharacterDataType("enum('a','b')")).toBe(true);
    expect(isMysqlCharacterDataType("set('x','y')")).toBe(true);
    expect(isMysqlCharacterDataType("int")).toBe(false);
    expect(isMysqlCharacterDataType("bigint(20) unsigned")).toBe(false);
    expect(isMysqlCharacterDataType("decimal(10,2)")).toBe(false);
    expect(isMysqlCharacterDataType("float")).toBe(false);
    expect(isMysqlCharacterDataType("double")).toBe(false);
    expect(isMysqlCharacterDataType("date")).toBe(false);
    expect(isMysqlCharacterDataType("datetime")).toBe(false);
    expect(isMysqlCharacterDataType("timestamp")).toBe(false);
    expect(isMysqlCharacterDataType("json")).toBe(false);
    expect(isMysqlCharacterDataType("binary(16)")).toBe(false);
    expect(isMysqlCharacterDataType("varbinary(255)")).toBe(false);
    expect(isMysqlCharacterDataType("blob")).toBe(false);
    expect(isMysqlCharacterDataType("geometry")).toBe(false);
  });
});
