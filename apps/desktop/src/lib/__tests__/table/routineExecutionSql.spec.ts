import { describe, expect, it } from "vitest";
import { buildProcedureExecutionSqlFromValues } from "@/lib/table/routineExecutionSql";
import { routineParametersFromResult, routineParametersQuery, supportsRoutineParameterMetadata, xuguRoutineMetadataFromDefinition } from "@/lib/table/routineParameters";
import type { QueryResult } from "@/types/database";

function queryResult(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

describe("MySQL routine execution SQL", () => {
  it("binds OUT parameters without requiring user input", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "mysql",
      schema: "app",
      routineName: "double_value",
      parameters: [
        { name: "p_input", dataType: "int", mode: "IN", ordinal: 1, value: "5" },
        { name: "p_output", dataType: "int", mode: "OUT", ordinal: 2, value: "ignored" },
      ],
    });

    expect(sql).toBe(["SET @dbx_output_2 = NULL;", "CALL `double_value`(5, @dbx_output_2);", "SELECT @dbx_output_2 AS `p_output`;"].join("\n"));
  });

  it("initializes INOUT variables and returns all output values", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "mysql",
      schema: "app",
      routineName: "adjust_values",
      parameters: [
        { name: "p_delta", dataType: "int", mode: "IN", ordinal: 1, value: "5" },
        { name: "p_total", dataType: "int", mode: "INOUT", ordinal: 2, value: "10" },
        { name: "p_status", dataType: "varchar(16)", mode: "OUT", ordinal: 3, value: "" },
      ],
    });

    expect(sql).toBe(["SET @dbx_output_2 = 10;", "SET @dbx_output_3 = NULL;", "CALL `adjust_values`(5, @dbx_output_2, @dbx_output_3);", "SELECT @dbx_output_2 AS `p_total`, @dbx_output_3 AS `p_status`;"].join("\n"));
  });

  it("keeps input-only procedure calls unchanged", () => {
    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "mysql",
        schema: "app",
        routineName: "save_value",
        parameters: [{ name: "p_value", dataType: "varchar(32)", mode: "IN", ordinal: 1, value: "O'Reilly" }],
      }),
    ).toBe("CALL `save_value`('O''Reilly');");
  });

  it("uses MySQL parameter modes to generate output bindings", () => {
    const parameters = routineParametersFromResult(
      queryResult(
        ["name", "data_type", "mode", "ordinal", "has_default"],
        [
          ["p_input", "int", "IN", 1, false],
          ["p_output", "int", "OUT", 2, false],
        ],
      ),
      "mysql",
    );

    expect(parameters.map((parameter) => parameter.mode)).toEqual(["IN", "OUT"]);
    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "mysql",
        routineName: "double_value",
        parameters: parameters.map((parameter) => ({ ...parameter, value: parameter.mode === "IN" ? "5" : "" })),
      }),
    ).toContain("CALL `double_value`(5, @dbx_output_2);");
  });
});

describe("SQL Server routine execution SQL", () => {
  it("declares and selects OUT parameters", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "sqlserver",
      schema: "dbo",
      routineName: "Sys_CreatePrimaryKeyValue",
      parameters: [
        { name: "@tableName", dataType: "varchar(64)", mode: "IN", ordinal: 1, value: "users" },
        { name: "@returnValue", dataType: "varchar(128)", mode: "OUT", ordinal: 2, value: "" },
      ],
    });

    expect(sql).toBe(["DECLARE @dbx_output_2 varchar(128);", "EXEC [dbo].[Sys_CreatePrimaryKeyValue] @tableName = 'users', @returnValue = @dbx_output_2 OUTPUT;", "SELECT @dbx_output_2 AS [returnValue];"].join("\n"));
  });

  it("initializes INOUT parameters and keeps numeric values unquoted", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "sqlserver",
      schema: "dbo",
      routineName: "adjust_amount",
      parameters: [{ name: "@amount", dataType: "decimal(18,4)", mode: "INOUT", ordinal: 1, value: "12.5000" }],
    });

    expect(sql).toBe(["DECLARE @dbx_output_1 decimal(18,4) = 12.5000;", "EXEC [dbo].[adjust_amount] @amount = @dbx_output_1 OUTPUT;", "SELECT @dbx_output_1 AS [amount];"].join("\n"));
  });

  it("preserves IN parameters and omission of requested defaults", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "sqlserver",
      schema: "dbo",
      routineName: "refresh_cache",
      parameters: [
        { name: "@scope", dataType: "varchar(32)", mode: "IN", ordinal: 1, value: "all" },
        { name: "@timeout", dataType: "int", mode: "IN", ordinal: 2, value: "30", hasDefault: true, useDefault: true },
      ],
    });

    expect(sql).toBe("EXEC [dbo].[refresh_cache] @scope = 'all';");
  });

  it("keeps no-parameter procedures valid and ignores RETURN metadata", () => {
    expect(buildProcedureExecutionSqlFromValues({ databaseType: "sqlserver", schema: "dbo", routineName: "ping", parameters: [] })).toBe("EXEC [dbo].[ping];");
    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "sqlserver",
        schema: "dbo",
        routineName: "ping",
        parameters: [{ name: "return_status", dataType: "int", mode: "RETURN", ordinal: 0, value: "" }],
      }),
    ).toBe("EXEC [dbo].[ping];");
  });

  it("preserves SQL Server declaration lengths, MAX, and decimal precision", () => {
    const parameters = routineParametersFromResult(
      queryResult(
        ["name", "data_type", "mode", "ordinal", "has_default", "max_length", "precision", "scale", "type_schema", "is_user_defined"],
        [
          ["@short", "varchar", "OUT", 1, false, 64, 0, 0, "sys", false],
          ["@long", "varchar", "OUT", 2, false, -1, 0, 0, "sys", false],
          ["@amount", "decimal", "OUT", 3, false, 17, 18, 4, "sys", false],
        ],
      ),
      "sqlserver",
    );

    expect(parameters.map((parameter) => parameter.dataType)).toEqual(["varchar(64)", "varchar(max)", "decimal(18,4)"]);
    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "sqlserver",
        schema: "dbo",
        routineName: "collect_outputs",
        parameters: parameters.map((parameter) => ({ ...parameter, value: "" })),
      }),
    ).toContain(["DECLARE @dbx_output_1 varchar(64);", "DECLARE @dbx_output_2 varchar(max);", "DECLARE @dbx_output_3 decimal(18,4);"].join("\n"));

    const metadataSql = routineParametersQuery({ database: "app", databaseType: "sqlserver", schema: "dbo", routineName: "save" });
    expect(metadataSql).toContain("JOIN sys.types t ON t.user_type_id = p.user_type_id");
    expect(metadataSql).toContain("p.max_length AS max_length");
    expect(metadataSql).toContain("p.precision AS precision");
    expect(metadataSql).toContain("p.scale AS scale");
  });

  it("quotes Oracle routine metadata aliases for legacy Oracle syntax", () => {
    const sql = routineParametersQuery({ database: "XE", databaseType: "oracle", schema: "DBX_TEST", routineName: "demo" });

    expect(sql).toContain('ARGUMENT_NAME AS "name"');
    expect(sql).toContain('DEFAULTED AS "has_default"');
  });
});

describe("Oracle routine execution SQL", () => {
  it("declares OUT variables, passes them to the call, and prints them", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "oracle",
      schema: "APP",
      routineName: "GET_NAME",
      parameters: [
        { name: "P_ID", dataType: "NUMBER", mode: "IN", ordinal: 1, value: "1" },
        { name: "P_NAME", dataType: "VARCHAR2", mode: "OUT", ordinal: 2, value: "ignored" },
      ],
    });

    expect(sql).toBe(["DECLARE", "  dbx_output_2 VARCHAR2(32767);", "BEGIN", '  "APP"."GET_NAME"(1, dbx_output_2);', "  DBMS_OUTPUT.PUT_LINE('P_NAME = ' || SUBSTR(dbx_output_2, 1, 4000));", "END;"].join("\n"));
  });

  it("initializes IN OUT variables from the entered value", () => {
    const parameters = routineParametersFromResult(queryResult(["name", "data_type", "mode", "ordinal", "has_default"], [["P_COUNTER", "NUMBER", "IN/OUT", 1, "N"]]), "oracle");

    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "oracle",
        schema: "APP",
        routineName: "BUMP",
        parameters: parameters.map((parameter) => ({ ...parameter, value: "5" })),
      }),
    ).toBe(["DECLARE", "  dbx_output_1 NUMBER := 5;", "BEGIN", '  "APP"."BUMP"(dbx_output_1);', "  DBMS_OUTPUT.PUT_LINE('P_COUNTER = ' || dbx_output_1);", "END;"].join("\n"));
  });

  it("binds several OUT parameters of different types", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "oracle",
      schema: "APP",
      routineName: "MULTI",
      parameters: [
        { name: "P_ID", dataType: "NUMBER", mode: "IN", ordinal: 1, value: "3" },
        { name: "O_NUM", dataType: "NUMBER", mode: "OUT", ordinal: 2, value: "" },
        { name: "O_TEXT", dataType: "VARCHAR2", mode: "OUT", ordinal: 3, value: "" },
        { name: "O_DATE", dataType: "DATE", mode: "OUT", ordinal: 4, value: "" },
      ],
    });

    expect(sql).toBe(
      [
        "DECLARE",
        "  dbx_output_2 NUMBER;",
        "  dbx_output_3 VARCHAR2(32767);",
        "  dbx_output_4 DATE;",
        "BEGIN",
        '  "APP"."MULTI"(3, dbx_output_2, dbx_output_3, dbx_output_4);',
        "  DBMS_OUTPUT.PUT_LINE('O_NUM = ' || dbx_output_2);",
        "  DBMS_OUTPUT.PUT_LINE('O_TEXT = ' || SUBSTR(dbx_output_3, 1, 4000));",
        "  DBMS_OUTPUT.PUT_LINE('O_DATE = ' || dbx_output_4);",
        "END;",
      ].join("\n"),
    );
  });

  it("switches to named arguments when an omitted default precedes an OUT parameter", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "oracle",
      schema: "APP",
      routineName: "WITH_DEFAULT",
      parameters: [
        { name: "P_ID", dataType: "NUMBER", mode: "IN", ordinal: 1, value: "1" },
        { name: "P_FLAG", dataType: "VARCHAR2", mode: "IN", ordinal: 2, value: "", hasDefault: true, useDefault: true },
        { name: "O_MSG", dataType: "VARCHAR2", mode: "OUT", ordinal: 3, value: "" },
      ],
    });

    expect(sql).toContain('  "APP"."WITH_DEFAULT"("P_ID" => 1, "O_MSG" => dbx_output_3);');
  });

  it("sizes unconstrained types and skips values that cannot be printed", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "oracle",
      schema: "APP",
      routineName: "TYPES",
      parameters: [
        { name: "O_CHAR", dataType: "CHAR", mode: "OUT", ordinal: 1, value: "" },
        { name: "O_NCHAR", dataType: "NCHAR", mode: "OUT", ordinal: 2, value: "" },
        { name: "O_NVC", dataType: "NVARCHAR2", mode: "OUT", ordinal: 3, value: "" },
        { name: "O_RAW", dataType: "RAW", mode: "OUT", ordinal: 4, value: "" },
        { name: "O_CUR", dataType: "REF CURSOR", mode: "OUT", ordinal: 5, value: "" },
        { name: "O_BOOL", dataType: "PL/SQL BOOLEAN", mode: "OUT", ordinal: 6, value: "" },
        { name: "O_BLOB", dataType: "BLOB", mode: "OUT", ordinal: 7, value: "" },
        { name: "O_TS", dataType: "TIMESTAMP WITH TIME ZONE", mode: "OUT", ordinal: 8, value: "" },
      ],
    });

    expect(sql).toBe(
      [
        "DECLARE",
        "  dbx_output_1 CHAR(2000);",
        "  dbx_output_2 NCHAR(1000);",
        "  dbx_output_3 NVARCHAR2(10922);",
        "  dbx_output_4 RAW(32767);",
        "  dbx_output_5 SYS_REFCURSOR;",
        "  dbx_output_6 BOOLEAN;",
        "  dbx_output_7 BLOB;",
        "  dbx_output_8 TIMESTAMP WITH TIME ZONE;",
        "BEGIN",
        '  "APP"."TYPES"(dbx_output_1, dbx_output_2, dbx_output_3, dbx_output_4, dbx_output_5, dbx_output_6, dbx_output_7, dbx_output_8);',
        "  DBMS_OUTPUT.PUT_LINE('O_CHAR = ' || SUBSTR(dbx_output_1, 1, 4000));",
        "  DBMS_OUTPUT.PUT_LINE('O_NCHAR = ' || SUBSTR(dbx_output_2, 1, 4000));",
        "  DBMS_OUTPUT.PUT_LINE('O_NVC = ' || SUBSTR(dbx_output_3, 1, 4000));",
        "  DBMS_OUTPUT.PUT_LINE('O_TS = ' || dbx_output_8);",
        "END;",
      ].join("\n"),
    );
  });

  it("keeps input-only procedure calls unchanged", () => {
    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "oracle",
        schema: "APP",
        routineName: "SAVE_VALUE",
        parameters: [
          { name: "P_ID", dataType: "NUMBER", mode: "IN", ordinal: 1, value: "1" },
          { name: "P_NAME", dataType: "VARCHAR2", mode: "IN", ordinal: 2, value: "O'Reilly" },
        ],
      }),
    ).toBe("BEGIN\n  \"APP\".\"SAVE_VALUE\"(1, 'O''Reilly');\nEND;");
  });

  it("uses the same output bindings for OceanBase Oracle mode", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "oceanbase-oracle",
      schema: "APP",
      routineName: "GET_NAME",
      parameters: [{ name: "P_NAME", dataType: "VARCHAR2", mode: "OUT", ordinal: 1, value: "" }],
    });

    expect(sql).toContain('  "APP"."GET_NAME"(dbx_output_1);');
  });
});

describe("XuguDB routine parameter metadata", () => {
  it("parses modes, nested types, defaults, comments, and quoted identifiers", () => {
    const metadata = xuguRoutineMetadataFromDefinition(`
CREATE OR REPLACE PROCEDURE "AppSchema"."MixedCaseProcedure" (
  "p_required" IN INTEGER,
  p_text VARCHAR(50) DEFAULT 'a,b -- literal',
  p_amount IN /* mode separator */ OUT NUMERIC(12, 3) := -1.250,
  p_result OUT VARCHAR(100),
  p_comment IN VARCHAR(40) DEFAULT '/* literal */'
) AS
BEGIN
  NULL;
END;`);

    expect(metadata.kind).toBe("PROCEDURE");
    expect(metadata.returnType).toBeUndefined();
    expect(metadata.parameters).toEqual([
      { name: "p_required", dataType: "INTEGER", mode: "IN", ordinal: 1, hasDefault: false, defaultValue: undefined },
      { name: "p_text", dataType: "VARCHAR(50)", mode: "IN", ordinal: 2, hasDefault: true, defaultValue: "'a,b -- literal'" },
      { name: "p_amount", dataType: "NUMERIC(12, 3)", mode: "INOUT", ordinal: 3, hasDefault: true, defaultValue: "-1.250" },
      { name: "p_result", dataType: "VARCHAR(100)", mode: "OUT", ordinal: 4, hasDefault: false, defaultValue: undefined },
      { name: "p_comment", dataType: "VARCHAR(40)", mode: "IN", ordinal: 5, hasDefault: true, defaultValue: "'/* literal */'" },
    ]);
  });

  it("parses function parameters and its return type", () => {
    const metadata = xuguRoutineMetadataFromDefinition(`
CREATE OR REPLACE FUNCTION calculate_total(
  p_amount IN NUMERIC(10,2),
  p_rate NUMERIC(5,2) DEFAULT 0.10
) RETURN NUMERIC(12,3)
AS
BEGIN
  RETURN p_amount * p_rate;
END;`);

    expect(metadata).toEqual({
      kind: "FUNCTION",
      returnType: "NUMERIC(12,3)",
      parameters: [
        { name: "p_amount", dataType: "NUMERIC(10,2)", mode: "IN", ordinal: 1, hasDefault: false, defaultValue: undefined },
        { name: "p_rate", dataType: "NUMERIC(5,2)", mode: "IN", ordinal: 2, hasDefault: true, defaultValue: "0.10" },
      ],
    });
  });

  it("handles routines without parentheses and fails closed for malformed headers", () => {
    expect(xuguRoutineMetadataFromDefinition("CREATE FUNCTION ping RETURN INTEGER AS BEGIN RETURN 1; END;")).toEqual({ kind: "FUNCTION", parameters: [], returnType: "INTEGER" });
    expect(xuguRoutineMetadataFromDefinition("CREATE PROCEDURE broken(p_value IN INTEGER AS BEGIN NULL; END;")).toEqual({ kind: "PROCEDURE", parameters: [] });
    expect(xuguRoutineMetadataFromDefinition("CREATE FUNCTION broken(p_value INTEGER) AS BEGIN RETURN p_value; END;")).toEqual({
      kind: "FUNCTION",
      parameters: [{ name: "p_value", dataType: "INTEGER", mode: "IN", ordinal: 1, hasDefault: false, defaultValue: undefined }],
      returnType: undefined,
    });
    expect(xuguRoutineMetadataFromDefinition("CREATE PROCEDURE broken(p_value VARCHAR DEFAULT 'unterminated) AS BEGIN NULL; END;")).toEqual({ parameters: [] });
    expect(xuguRoutineMetadataFromDefinition("CREATE PROCEDURE broken(/* unterminated")).toEqual({ parameters: [] });
    expect(xuguRoutineMetadataFromDefinition("SELECT 'PROCEDURE fake(p INT)' FROM dual")).toEqual({ parameters: [] });
  });

  it("supports INOUT spelling, escaped names, and equals defaults", () => {
    expect(xuguRoutineMetadataFromDefinition('CREATE PROCEDURE p("p""name" INOUT DECIMAL(9,2) = COALESCE(-1, 0)) AS BEGIN NULL; END;').parameters).toEqual([
      {
        name: 'p"name',
        dataType: "DECIMAL(9,2)",
        mode: "INOUT",
        ordinal: 1,
        hasDefault: true,
        defaultValue: "COALESCE(-1, 0)",
      },
    ]);
  });

  it("enables source-backed metadata without generating an ALL_ARGUMENTS query", () => {
    expect(supportsRoutineParameterMetadata("xugu")).toBe(true);
    expect(routineParametersQuery({ database: "sample", databaseType: "xugu", schema: "app", routineName: "save_value" })).toBeNull();
  });
});

describe("XuguDB procedure execution SQL", () => {
  it("supplies OUT arguments and preserves INOUT input values", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "xugu",
      schema: "AppSchema",
      routineName: "adjust_amount",
      parameters: [
        { name: "p_input", dataType: "INTEGER", mode: "IN", ordinal: 1, value: "5" },
        { name: "p_amount", dataType: "NUMERIC(12,3)", mode: "INOUT", ordinal: 2, value: "2.500" },
        { name: "p_status", dataType: "VARCHAR(20)", mode: "OUT", ordinal: 3, value: "ignored" },
      ],
    });

    expect(sql).toBe('CALL "AppSchema"."adjust_amount"(5, 2.500, NULL);');
  });

  it("uses named notation when a middle default is omitted", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "xugu",
      schema: "AppSchema",
      routineName: "save_value",
      parameters: [
        { name: "p_required", dataType: "INTEGER", mode: "IN", ordinal: 1, value: "1" },
        { name: "p_label", dataType: "VARCHAR(20)", mode: "IN", ordinal: 2, value: "unused", hasDefault: true, useDefault: true },
        { name: "p_amount", dataType: "NUMERIC(12,3)", mode: "INOUT", ordinal: 3, value: "2.500" },
        { name: "p_result", dataType: "VARCHAR(20)", mode: "OUT", ordinal: 4, value: "" },
      ],
    });

    expect(sql).toBe('CALL "AppSchema"."save_value"("p_required" => 1, "p_amount" => 2.500, "p_result" => NULL);');
  });

  it("omits trailing defaults positionally and escapes string values", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "xugu",
      schema: "AppSchema",
      routineName: "save_label",
      parameters: [
        { name: "p_label", dataType: "VARCHAR(30)", mode: "IN", ordinal: 1, value: "O'Reilly" },
        { name: "p_enabled", dataType: "BOOLEAN", mode: "IN", ordinal: 2, value: "true", hasDefault: true, useDefault: true },
      ],
    });

    expect(sql).toBe("CALL \"AppSchema\".\"save_label\"('O''Reilly');");
  });
});
