import { describe, expect, it } from "vitest";
import { queryResultTransferIsBinaryColumnType, queryResultTransferSqlLiteral, queryResultTransferTargetType } from "../queryResultTransferValues";

describe("query result transfer value literals", () => {
  it.each([
    ["sqlite", "BLOB", "X'0001fe'"],
    ["postgres", "bytea", "decode('0001fe', 'hex')"],
    ["sqlserver", "varbinary(max)", "0x0001fe"],
    ["oracle", "BLOB", "HEXTORAW('0001fe')"],
    ["oceanbase-oracle", "BLOB", "HEXTORAW('0001fe')"],
    ["mysql", "BLOB", "X'0001fe'"],
    ["h2", "BLOB", "X'0001fe'"],
    ["db2", "BLOB", "BX'0001fe'"],
  ] as const)("preserves binary bytes for %s", (databaseType, targetType, expected) => {
    expect(queryResultTransferTargetType("bytea", databaseType)).toBe(targetType);
    expect(queryResultTransferSqlLiteral("0x0001fe", databaseType, "bytea", targetType)).toBe(expected);
  });

  it("treats SQL Server timestamp/rowversion values as binary", () => {
    expect(queryResultTransferTargetType("timestamp", "postgres", "sqlserver")).toBe("bytea");
    expect(queryResultTransferTargetType("rowversion", "sqlite", "sqlserver")).toBe("BLOB");
    expect(queryResultTransferSqlLiteral("0x0001fe", "postgres", "timestamp", "bytea", "sqlserver")).toBe("decode('0001fe', 'hex')");
  });

  it("fails closed for an unverified binary dialect", () => {
    expect(queryResultTransferSqlLiteral("0x0001fe", "hive", "binary", "BINARY")).toBeUndefined();
  });

  it("fails closed for malformed canonical binary values", () => {
    expect(queryResultTransferSqlLiteral("0xnot-hex", "postgres", "bytea", "bytea")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("0x123", "sqlite", "blob", "BLOB")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("not encoded bytes", "postgres", "bytea", "bytea")).toBeUndefined();
    expect(queryResultTransferSqlLiteral([0, 256], "postgres", "bytea", "bytea")).toBeUndefined();
  });

  it("keeps the original bytes when the backend returns a typed byte array", () => {
    expect(queryResultTransferSqlLiteral(new Uint8Array([0, 255]), "postgres", "bytea", "bytea")).toBe("decode('00ff', 'hex')");
  });

  it("retains GoldenDB binary payloads whose bytes resemble hexadecimal display text", () => {
    // GoldendbAgent.resultValue returns canonical hex even for ASCII bytes.
    expect(queryResultTransferSqlLiteral("0x6465616462656566", "goldendb", "VARBINARY", "VARBINARY(16)", "goldendb")).toBe("X'6465616462656566'");
    expect(queryResultTransferSqlLiteral("0x307830306666", "goldendb", "BLOB", "BLOB", "goldendb")).toBe("X'307830306666'");
    expect(queryResultTransferSqlLiteral("0x00ff80", "goldendb", "BINARY", "BINARY(3)", "goldendb")).toBe("X'00ff80'");
    expect(queryResultTransferSqlLiteral("0x", "goldendb", "BLOB", "BLOB", "goldendb")).toBe("X''");
    expect(queryResultTransferSqlLiteral(null, "goldendb", "BLOB", "BLOB", "goldendb")).toBe("NULL");
  });

  it.each([
    ["sqlite", "1", "0"],
    ["postgres", "TRUE", "FALSE"],
    ["oracle", "1", "0"],
    ["oceanbase-oracle", "1", "0"],
    ["sqlserver", "1", "0"],
  ] as const)("aligns boolean literals with the target type for %s", (databaseType, expectedTrue, expectedFalse) => {
    const targetType = queryResultTransferTargetType("boolean", databaseType);
    expect(queryResultTransferSqlLiteral("true", databaseType, "boolean", targetType)).toBe(expectedTrue);
    expect(queryResultTransferSqlLiteral(false, databaseType, "boolean", targetType)).toBe(expectedFalse);
  });

  it("keeps exact numeric strings unquoted", () => {
    expect(queryResultTransferSqlLiteral("900719925474099312345", "postgres", "numeric", "NUMERIC")).toBe("900719925474099312345");
    expect(queryResultTransferSqlLiteral("12.3400", "oracle", "decimal", "NUMBER(10,4)")).toBe("12.3400");
  });

  it("preserves native boolean values even when metadata is absent", () => {
    expect(queryResultTransferSqlLiteral(true, "sqlite")).toBe("1");
    expect(queryResultTransferSqlLiteral(false, "postgres")).toBe("FALSE");
  });

  it.each(["postgres", "kingbase", "highgo", "vastbase", "gaussdb", "kwdb", "opengauss"] as const)("quotes %s backslashes and control characters independently of session string settings", (databaseType) => {
    expect(queryResultTransferSqlLiteral("C:\\new\\files\\'quote", databaseType, "text")).toBe("E'C:\\\\new\\\\files\\\\''quote'");
    expect(queryResultTransferSqlLiteral("line\n\t\r\x08\x0c\x01\x7f", databaseType, "text")).toBe("E'line\\x0a\\x09\\x0d\\x08\\x0c\\x01\\x7f'");
    expect(queryResultTransferSqlLiteral("O'Brien", databaseType, "text")).toBe("'O''Brien'");
    expect(queryResultTransferSqlLiteral("nul\0value", databaseType, "text")).toBeUndefined();
  });

  it("does not map exact decimals to floating point or an implicit zero scale", () => {
    expect(queryResultTransferTargetType("decimal(38,18)", "sqlserver", "mysql")).toBe("DECIMAL(38,18)");
    expect(queryResultTransferTargetType("decimal(65,30)", "postgres", "mysql")).toBe("NUMERIC");
    expect(queryResultTransferTargetType("numeric(65,30)", "oracle", "postgres")).toBe("CLOB");
    expect(queryResultTransferTargetType("decimal", "mysql", "mysql")).toBe("LONGTEXT");
    expect(queryResultTransferTargetType("numeric", "sqlite", "postgres")).toBe("TEXT");
    expect(queryResultTransferSqlLiteral("900719925474099312345.123456789", "sqlite", "numeric", "TEXT", "postgres")).toBe("'900719925474099312345.123456789'");
    expect(queryResultTransferSqlLiteral(Number("9007199254740993"), "postgres", "bigint")).toBeUndefined();
  });

  it("keeps PostgreSQL int8 and MySQL unsigned result metadata within range", () => {
    expect(queryResultTransferTargetType("int8", "mysql", "postgres")).toBe("BIGINT");
    expect(queryResultTransferTargetType("bigint", "mysql", "mysql")).toBe("DECIMAL(20,0)");
    expect(queryResultTransferTargetType("bigint unsigned", "postgres", "mysql")).toBe("DECIMAL(20,0)");
    expect(queryResultTransferTargetType("bigint", "sqlite", "mysql")).toBe("TEXT");
    expect(queryResultTransferSqlLiteral("18446744073709551615", "sqlite", "bigint", "TEXT", "mysql")).toBe("'18446744073709551615'");
  });

  it("preserves MySQL precision and lengths that native result headers omit", () => {
    expect(queryResultTransferTargetType("datetime", "mysql", "mysql")).toBe("datetime(6)");
    expect(queryResultTransferTargetType("time", "mysql", "mysql")).toBe("time(6)");
    expect(queryResultTransferTargetType("varchar", "mysql", "mysql")).toBe("LONGTEXT");
    expect(queryResultTransferTargetType("varbinary", "mysql", "mysql")).toBe("LONGBLOB");
    expect(queryResultTransferTargetType("bit", "mysql", "mysql")).toBe("BIT(64)");
  });

  it("widens bare character and binary metadata without using dialect default lengths", () => {
    expect(queryResultTransferTargetType("VARCHAR2", "oracle", "oracle")).toBe("CLOB");
    expect(queryResultTransferTargetType("NVARCHAR2", "oracle", "oracle")).toBe("NCLOB");
    expect(queryResultTransferTargetType("RAW", "oracle", "oracle")).toBe("BLOB");
    expect(queryResultTransferTargetType("NVARCHAR", "sqlserver", "sqlserver")).toBe("nvarchar(max)");
    expect(queryResultTransferTargetType("CHAR", "sqlserver", "sqlserver")).toBe("nvarchar(max)");
    expect(queryResultTransferTargetType("VARBINARY", "sqlserver", "sqlserver")).toBe("varbinary(max)");
    expect(queryResultTransferTargetType("NVARCHAR(32)", "sqlserver", "sqlserver")).toBe("NVARCHAR(32)");
    expect(queryResultTransferTargetType("VARCHAR", "h2", "h2")).toBe("CLOB");
  });

  it.each(["BINARY VARYING", "BINARY LARGE OBJECT", "VARBINARY", "BLOB"])("preserves H2 bytes reported as %s", (sourceType) => {
    expect(queryResultTransferIsBinaryColumnType(sourceType, "h2")).toBe(true);
    expect(queryResultTransferTargetType(sourceType, "h2", "h2").toUpperCase()).toBe("BLOB");
    // The original wire name also becomes the target type when source DDL is reused.
    expect(queryResultTransferSqlLiteral("0x00ff", "h2", sourceType, sourceType, "h2")).toBe("X'00ff'");
    expect(queryResultTransferSqlLiteral("0x", "h2", sourceType, sourceType, "h2")).toBe("X''");
    expect(queryResultTransferTargetType(sourceType, "postgres", "h2")).toBe("bytea");
    expect(queryResultTransferSqlLiteral("0x00ff", "postgres", sourceType, "bytea", "h2")).toBe("decode('00ff', 'hex')");
  });

  it("marks H2 JSON payloads as JSON instead of converting them to JSON strings", () => {
    expect(queryResultTransferTargetType("JSON", "h2", "h2")).toBe("JSON");
    for (const payload of ['{"a":1}', "[1,2]", '"hello"', "true", "123", "null"]) {
      expect(queryResultTransferSqlLiteral(payload, "h2", "JSON", undefined, "h2")).toBe(`JSON '${payload}'`);
    }
    expect(queryResultTransferSqlLiteral('{"path":"C:\\\\o\'clock"}', "h2", "JSON", "JSON", "h2")).toBe("JSON '{\"path\":\"C:\\\\o''clock\"}'");
    expect(queryResultTransferSqlLiteral(null, "h2", "JSON", "JSON", "h2")).toBe("NULL");
    // Existing H2 JSON columns may receive structured values from another source.
    expect(queryResultTransferSqlLiteral({ a: 1 }, "h2", "jsonb", "JSON", "postgres")).toBe("JSON '{\"a\":1}'");
    expect(queryResultTransferSqlLiteral([1, 2], "h2", "_int4", "JSON", "postgres")).toBe("JSON '[1,2]'");
  });

  it.each(["TIME", "TIMESTAMP", "TIME WITH TIME ZONE", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITHOUT TIME ZONE"])("preserves H2 fractional precision omitted from %s result metadata", (sourceType) => {
    const targetType = sourceType.replace(/^(TIME|TIMESTAMP)\b/, "$1(9)").toLowerCase();
    expect(queryResultTransferTargetType(sourceType, "h2", "h2")).toBe(targetType);
  });

  it("retains explicit H2 temporal precision and accepts other sources at full precision", () => {
    expect(queryResultTransferTargetType("TIMESTAMP(3)", "h2", "h2")).toBe("TIMESTAMP(3)");
    expect(queryResultTransferTargetType("TIMESTAMP(9)", "h2", "oracle")).toBe("TIMESTAMP(9)");
    expect(queryResultTransferTargetType("datetime2", "h2", "sqlserver")).toBe("TIMESTAMP(9)");
  });

  it.each([
    ["TIMESTAMP", "h2"],
    ["TIMESTAMP", "oracle"],
    ["TimeStampDTY", "oracle"],
    ["datetime2", "sqlserver"],
  ] as const)("preserves possible precision in %s from %s when a destination stops at microseconds", (sourceType, sourceDatabaseType) => {
    const value = sourceDatabaseType === "sqlserver" ? "2026-10-07 12:34:56.1234567" : "2026-10-07 12:34:56.123456789";
    expect(queryResultTransferTargetType(sourceType, "postgres", sourceDatabaseType)).toBe("TEXT");
    expect(queryResultTransferTargetType(sourceType, "mysql", sourceDatabaseType)).toBe("LONGTEXT");
    expect(queryResultTransferSqlLiteral(value, "postgres", sourceType, undefined, sourceDatabaseType)).toBe(`'${value}'`);
    expect(queryResultTransferSqlLiteral(value, "mysql", sourceType, undefined, sourceDatabaseType)).toBe(`CONVERT(X'${Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("")}' USING utf8mb4)`);
  });

  it("uses temporal target columns only when their precision can retain the source", () => {
    expect(queryResultTransferTargetType("TIMESTAMP", "sqlserver", "h2")).toBe("nvarchar(max)");
    expect(queryResultTransferTargetType("TIMESTAMP(6)", "postgres", "oracle")).toBe("TIMESTAMP");
    expect(queryResultTransferTargetType("TIMESTAMP(6)", "mysql", "oracle")).toBe("DATETIME(6)");
    expect(queryResultTransferTargetType("TIMESTAMP(7)", "sqlserver", "oracle")).toBe("datetime2(7)");
    expect(queryResultTransferTargetType("TIMESTAMP", "db2", "h2")).toBe("TIMESTAMP(9)");
    expect(queryResultTransferTargetType("TIMESTAMP", "db2", "db2")).toBe("TIMESTAMP(12)");
    expect(queryResultTransferTargetType("TIMESTAMP(12)", "h2", "db2")).toBe("CLOB");
  });

  it.each([
    ["postgres", "TIMESTAMP(6)"],
    ["mysql", "DATETIME(6)"],
    ["sqlserver", "datetime2(6)"],
    ["h2", "TIMESTAMP(6)"],
    ["oracle", "TIMESTAMP(6)"],
    ["db2", "TIMESTAMP(6)"],
  ] as const)("rejects nonzero fractional digits beyond the explicit %s target precision", (databaseType, targetType) => {
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56.123456789", databaseType, "TIMESTAMP", targetType, "h2")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56.123456000", databaseType, "TIMESTAMP", targetType, "h2")).not.toBeUndefined();
  });

  it("checks known target limits without confusing bare result headers with default declaration precision", () => {
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56.1234567", "postgres", "datetime2", "timestamp", "sqlserver")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56.12345678", "sqlserver", "TIMESTAMP", "datetime2", "h2")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("12:34:56.1234567+08:00", "h2", "TIME WITH TIME ZONE", "TIME(6) WITH TIME ZONE", "h2")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("12:34:56.000000001", "mysql", "time", "TIME(0)", "mysql")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("-12:34:56.000000001", "mysql", "time", "TIME(0)", "mysql")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56.123456789", "h2", "TIMESTAMP", "TIMESTAMP", "h2")).not.toBeUndefined();
    expect(queryResultTransferSqlLiteral("2026-10-07T12:34:56.123456789", "oracle", "TIMESTAMP", "TIMESTAMP", "oracle")).not.toBeUndefined();
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56.123456", "mysql", "datetime", "datetime", "mysql")).not.toBeUndefined();
  });

  it("preserves SQL Server datetime tick values without rounding exact timestamps from another source", () => {
    for (const fraction of ["001", "002", "003", "007", "897"]) {
      expect(queryResultTransferSqlLiteral(`2026-10-07 12:34:56.${fraction}`, "sqlserver", "TIMESTAMP(3)", "datetime", "h2")).toBeUndefined();
    }
    for (const fraction of ["000", "010", "020", "100", "990"]) {
      expect(queryResultTransferSqlLiteral(`2026-10-07 12:34:56.${fraction}`, "sqlserver", "TIMESTAMP(3)", "datetime", "h2")).not.toBeUndefined();
    }
    for (const sourceType of ["datetime", "datetimen"]) {
      for (const fraction of ["000", "003", "007", "897"]) {
        expect(queryResultTransferSqlLiteral(`2026-10-07 12:34:56.${fraction}`, "sqlserver", sourceType, "datetime", "sqlserver")).not.toBeUndefined();
      }
      expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56.001", "sqlserver", sourceType, "datetime", "sqlserver")).toBeUndefined();
      expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56.896666666", "sqlserver", sourceType, "datetime", "sqlserver")).toBeUndefined();
    }
    // The native driver publishes 3-digit canonical display text, not raw ticks.
    expect(queryResultTransferTargetType("datetime", "postgres", "sqlserver")).toBe("TIMESTAMP");
    expect(queryResultTransferSqlLiteral("2026-06-29 10:11:12.897", "postgres", "datetime", undefined, "sqlserver")).toBe("'2026-06-29 10:11:12.897'");
  });

  it("rejects clock fields that DATE and SMALLDATETIME would discard", () => {
    for (const databaseType of ["postgres", "mysql", "sqlserver", "h2", "db2"] as const) {
      expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56", databaseType, "TIMESTAMP", "DATE", "h2")).toBeUndefined();
      expect(queryResultTransferSqlLiteral("2026-10-07 00:00:00.000", databaseType, "TIMESTAMP", "DATE", "h2")).not.toBeUndefined();
    }
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:01", "sqlserver", "datetime2", "smalldatetime", "sqlserver")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:00.001", "sqlserver", "datetime2", "smalldatetime", "sqlserver")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:00.000", "sqlserver", "datetime2", "smalldatetime", "sqlserver")).not.toBeUndefined();
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56", "oracle", "TIMESTAMP", "DATE", "oracle")).toBe("TO_DATE('2026-10-07 12:34:56', 'YYYY-MM-DD HH24:MI:SS')");
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56", "sqlite", "TEXT", "DATE", "sqlite")).toBe("'2026-10-07 12:34:56'");
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56.123456789", "sqlite", "TEXT", "DATE", "sqlite")).toBe("'2026-10-07 12:34:56.123456789'");
  });

  it("normalizes SQL Server TDS type names into usable target SQL types", () => {
    expect(queryResultTransferTargetType("intn", "sqlserver", "sqlserver")).toBe("bigint");
    expect(queryResultTransferTargetType("numericn", "sqlserver", "sqlserver")).toBe("nvarchar(max)");
    expect(queryResultTransferTargetType("datetimen", "sqlserver", "sqlserver")).toBe("datetime2(7)");
    expect(queryResultTransferTargetType("guid", "sqlserver", "sqlserver")).toBe("uniqueidentifier");
    expect(queryResultTransferTargetType("daten", "sqlserver", "sqlserver")).toBe("date");
    expect(queryResultTransferTargetType("timen", "sqlserver", "sqlserver")).toBe("time(7)");
    expect(queryResultTransferTargetType("datetimeoffsetn", "sqlserver", "sqlserver")).toBe("datetimeoffset(7)");
    expect(queryResultTransferSqlLiteral("9223372036854775807", "postgres", "intn", "BIGINT", "sqlserver")).toBe("9223372036854775807");
    expect(queryResultTransferSqlLiteral("1", "postgres", "bitn", "BOOLEAN", "sqlserver")).toBe("TRUE");
  });

  it("does not embed source type names as extra SQL statements", () => {
    expect(queryResultTransferTargetType("integer); DROP TABLE other_table; --", "postgres", "postgres")).toBe("TEXT");
    expect(queryResultTransferTargetType("_text[]); DROP TABLE other_table; --", "postgres", "postgres")).toBe("TEXT");
    expect(queryResultTransferTargetType('"Custom Type"', "postgres", "postgres")).toBe("TEXT");
    expect(queryResultTransferTargetType("integer DEFAULT dangerous_function()", "postgres", "postgres")).toBe("TEXT");
    expect(queryResultTransferTargetType("numeric DEFAULT dangerous_function()", "oracle", "oracle")).toBe("CLOB");
    expect(queryResultTransferTargetType("_integer DEFAULT dangerous_function()", "postgres", "postgres")).toBe("TEXT");
    expect(queryResultTransferTargetType("my_custom_type", "postgres", "postgres")).toBe("TEXT");
    expect(queryResultTransferSqlLiteral("FALSE", "postgres", "bool DEFAULT dangerous_function()", undefined, "postgres")).toBe("'FALSE'");
    expect(queryResultTransferSqlLiteral("not hex", "postgres", "blob DEFAULT dangerous_function()", undefined, "postgres")).toBe("'not hex'");
    expect(queryResultTransferSqlLiteral(["a", "b"], "postgres", "_my_custom_type", undefined, "postgres")).toBe('\'["a","b"]\'');
    expect(queryResultTransferTargetType("TIMESTAMP(6) WITH TIME ZONE", "oracle", "oracle")).toBe("TIMESTAMP(6) WITH TIME ZONE");
    expect(queryResultTransferTargetType("NUMBER(38, 6)", "oracle", "oracle")).toBe("number(38, 6)");
  });

  it("emits typed PostgreSQL arrays, including empty, nested and binary arrays", () => {
    expect(queryResultTransferTargetType("_int8", "postgres", "postgres")).toBe("int8[]");
    expect(queryResultTransferSqlLiteral(["9223372036854775807", null], "postgres", "_int8", "int8[]", "postgres")).toBe("ARRAY[9223372036854775807, NULL]::int8[]");
    expect(queryResultTransferSqlLiteral(["9223372036854775807", null], "postgres", "_int8", "_int8", "postgres")).toBe("ARRAY[9223372036854775807, NULL]::int8[]");
    expect(queryResultTransferSqlLiteral([], "postgres", "_text", "text[]", "postgres")).toBe("ARRAY[]::text[]");
    expect(
      queryResultTransferSqlLiteral(
        [
          [1, 2],
          [3, 4],
        ],
        "postgres",
        "_int4",
        "int4[]",
        "postgres",
      ),
    ).toBe("ARRAY[ARRAY[1, 2]::int4[], ARRAY[3, 4]::int4[]]::int4[]");
    expect(queryResultTransferSqlLiteral(["0x00ff"], "postgres", "_bytea", "bytea[]", "postgres")).toBe("ARRAY[decode('00ff', 'hex')]::bytea[]");
    expect(queryResultTransferSqlLiteral(["C:\\test"], "postgres", "_text", "text[]", "postgres")).toBe("ARRAY[E'C:\\\\test']::text[]");
    expect(queryResultTransferTargetType("int4[]", "sqlite", "postgres")).toBe("TEXT");
    expect(queryResultTransferSqlLiteral([1, null, 2], "sqlite", "int4[]", "TEXT", "postgres")).toBe("'[1,null,2]'");
  });

  it("preserves bit strings without interpreting them as text bytes or boolean truthiness", () => {
    expect(queryResultTransferSqlLiteral("00100101", "mysql", "bit", "BIT(64)", "mysql")).toBe("B'00100101'");
    expect(queryResultTransferSqlLiteral("00100101", "postgres", "bit", "BIT VARYING", "mysql")).toBe("B'00100101'");
    expect(queryResultTransferSqlLiteral("00100101", "sqlite", "bit", "TEXT", "mysql")).toBe("'00100101'");
    expect(queryResultTransferSqlLiteral("not-bits", "mysql", "bit", "BIT(64)", "mysql")).toBeUndefined();
    expect(queryResultTransferSqlLiteral(true, "postgres", "bit", "BOOLEAN", "sqlserver")).toBe("TRUE");
  });

  it("uses NLS-independent Oracle date and timestamp literals", () => {
    expect(queryResultTransferSqlLiteral("2026-10-07", "oracle", "DATE", "DATE", "oracle")).toBe("DATE '2026-10-07'");
    expect(queryResultTransferSqlLiteral("2026-10-07 12:34:56", "oracle", "DATE", "DATE", "oracle")).toBe("TO_DATE('2026-10-07 12:34:56', 'YYYY-MM-DD HH24:MI:SS')");
    expect(queryResultTransferSqlLiteral("2026-10-07T12:34:56.123456789", "oracle", "TIMESTAMP(9)", "TIMESTAMP(9)", "oracle")).toBe("TO_TIMESTAMP('2026-10-07 12:34:56.123456789', 'YYYY-MM-DD HH24:MI:SS.FF')");
    expect(queryResultTransferSqlLiteral("2026-10-07T12:34:56.123Z", "oracle", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH TIME ZONE", "oracle")).toBe("TO_TIMESTAMP_TZ('2026-10-07 12:34:56.123 +00:00', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')");
    expect(queryResultTransferSqlLiteral("07-OCT-26", "oracle", "DATE", "DATE", "oracle")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("2026-10-07T12:34:56.123", "oracle", "DATE", "DATE", "oracle")).toBeUndefined();
    expect(queryResultTransferTargetType("DATE", "postgres", "oracle")).toBe("TIMESTAMP");
    expect(queryResultTransferTargetType("TIMESTAMP WITH TIME ZONE", "mysql", "oracle")).toBe("LONGTEXT");
    expect(queryResultTransferTargetType("time", "oracle", "mysql")).toBe("CLOB");
  });

  it("normalizes Oracle-go wire timestamp names for reused DDL and generic targets", () => {
    expect(queryResultTransferTargetType("TimeStampDTY", "oracle", "oracle")).toBe("TIMESTAMP(9)");
    expect(queryResultTransferTargetType("TimeStampTZ_DTY", "oracle", "oracle")).toBe("TIMESTAMP(9) WITH TIME ZONE");
    expect(queryResultTransferTargetType("TIMESTAMP", "oracle", "oracle")).toBe("TIMESTAMP(9)");
    expect(queryResultTransferTargetType("TIMESTAMP WITH LOCAL TIME ZONE", "oracle", "oracle")).toBe("TIMESTAMP(9) with local time zone");
    expect(queryResultTransferSqlLiteral("2026-10-07T12:34:56.123456789", "oracle", "TimeStampDTY", "TimeStampDTY", "oracle")).toBe("TO_TIMESTAMP('2026-10-07 12:34:56.123456789', 'YYYY-MM-DD HH24:MI:SS.FF')");
    expect(queryResultTransferSqlLiteral("2026-10-07T12:34:56.123456789+08:00", "oracle", "TimeStampTZ_DTY", "TimeStampTZ_DTY", "oracle")).toBe("TO_TIMESTAMP_TZ('2026-10-07 12:34:56.123456789 +08:00', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')");
    expect(queryResultTransferTargetType("TimeStampDTY", "h2", "oracle")).toBe("TIMESTAMP(9)");
    expect(queryResultTransferTargetType("TimeStampTZ_DTY", "mysql", "oracle")).toBe("LONGTEXT");
  });

  it("preserves an empty Oracle BLOB rather than converting it to NULL", () => {
    expect(queryResultTransferSqlLiteral("0x", "oracle", "BLOB", "BLOB", "oracle")).toBe("EMPTY_BLOB()");
    expect(queryResultTransferSqlLiteral("0x", "oracle", "RAW", "RAW", "oracle")).toBeUndefined();
  });

  it("preserves empty Oracle CLOBs and rejects strings that VARCHAR2 would turn into NULL", () => {
    expect(queryResultTransferSqlLiteral("", "oracle", "text", "CLOB", "postgres")).toBe("EMPTY_CLOB()");
    expect(queryResultTransferSqlLiteral("", "oracle", "nvarchar", "NCLOB", "sqlserver")).toBe("EMPTY_CLOB()");
    expect(queryResultTransferSqlLiteral("", "oracle", "text", "VARCHAR2(4000)", "postgres")).toBeUndefined();
    expect(queryResultTransferSqlLiteral(null, "oracle", "text", "CLOB", "postgres")).toBe("NULL");
  });

  it.each(["CLOB", "NCLOB"])("chunks large Oracle %s text without breaking characters or escaping", (targetType) => {
    const value = "😀中文'\\ ".repeat(600);
    const literal = queryResultTransferSqlLiteral(value, "oracle", "text", targetType, "postgres")!;
    const constructor = targetType === "NCLOB" ? "TO_NCLOB" : "TO_CLOB";
    const chunks = [...literal.matchAll(new RegExp(`${constructor}\\('((?:''|[^'])*)'\\)`, "g"))].map((match) => match[1]!);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 3900)).toBe(true);
    expect(chunks.map((chunk) => chunk.replaceAll("''", "'")).join("")).toBe(value);
    expect(literal).toBe(chunks.map((chunk) => `${constructor}('${chunk}')`).join(" || "));
  });

  it("keeps the Oracle literal boundary explicit for non-LOB and unverified compatible drivers", () => {
    expect(queryResultTransferSqlLiteral("x".repeat(4000), "oracle", "text", "CLOB", "postgres")).toBe(`'${"x".repeat(4000)}'`);
    expect(queryResultTransferSqlLiteral("x".repeat(4001), "oracle", "text", "CLOB", "postgres")).toContain("TO_CLOB(");
    expect(queryResultTransferSqlLiteral("x".repeat(4001), "oceanbase-oracle", "text", "CLOB", "postgres")).toContain("TO_CLOB(");
    expect(queryResultTransferSqlLiteral("x".repeat(4001), "oracle", "text", "VARCHAR2(5000)", "postgres")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("x".repeat(4001), "dameng", "text", "CLOB", "postgres")).toBeUndefined();
    expect(queryResultTransferSqlLiteral("x".repeat(4001), "yashandb", "text", "CLOB", "postgres")).toBeUndefined();
  });
});
