import { describe, expect, it } from "vitest";
import { applyColumnFormatter, columnFormatterKeys, defaultIoTDBTimestampFormatter, forceCsvTextForTemporalColumns, formatIoTDBTimestampEditorValue, normalizeColumnFormatter, normalizeSupportedDateTimePattern, parseIoTDBTimestampEditorValue } from "@/lib/dataGrid/columnFormatter";

describe("columnFormatterKeys", () => {
  // MySQL query metadata mirrors the database into the schema slot, while the
  // table view has always keyed formatters with an empty schema.
  const mysqlQueryColumn = {
    connectionId: "conn1",
    database: "app",
    databaseType: "mysql",
    resultColumn: "created_at",
    displaySource: { database: "app", schema: "app", tableName: "users", sourceColumn: "created_at" },
  };
  const mysqlTableColumn = {
    connectionId: "conn1",
    database: "app",
    databaseType: "mysql",
    resultColumn: "created_at",
    tableMeta: { database: "app", tableName: "users" },
  };

  it("writes MySQL query-result saves under the table-view empty-schema key", () => {
    const keys = columnFormatterKeys(mysqlQueryColumn);
    expect(keys[0]).toBe("conn1::app::::users::created_at");
    // The mirrored spelling stays readable so older saves keep applying.
    expect(keys).toContain("conn1::app::app::users::created_at");
  });

  it("resolves a MySQL formatter saved from a query result in the table view", () => {
    const queryKeys = columnFormatterKeys(mysqlQueryColumn);
    const tableKeys = columnFormatterKeys(mysqlTableColumn);
    // A save writes keys[0]; the table-view read list must include that key.
    expect(tableKeys).toContain(queryKeys[0]!);
    expect(tableKeys[0]).toBe(queryKeys[0]);
    // Clearing from the table view removes the legacy mirrored save too.
    expect(tableKeys).toContain("conn1::app::app::users::created_at");
  });

  it("keeps the physical schema as the write key for schema-aware dialects", () => {
    const keys = columnFormatterKeys({
      connectionId: "conn1",
      database: "app",
      databaseType: "postgres",
      resultColumn: "created_at",
      displaySource: { database: "app", schema: "public", tableName: "users", sourceColumn: "created_at" },
    });
    expect(keys).toEqual(["conn1::app::public::users::created_at"]);
  });

  it("returns no keys without a physical table identity", () => {
    expect(columnFormatterKeys({ connectionId: "conn1", database: "app", databaseType: "mysql", resultColumn: "total" })).toEqual([]);
    expect(
      columnFormatterKeys({
        connectionId: "conn1",
        database: "app",
        databaseType: "mysql",
        resultColumn: "total",
        // Cached legacy mapping without a resolvable physical table.
        displaySource: { sourceColumn: "total" },
      }),
    ).toEqual([]);
  });

  it("keys writes by the physical source column, not an alias", () => {
    const keys = columnFormatterKeys({ ...mysqlQueryColumn, resultColumn: "createdAt" });
    expect(keys[0]).toBe("conn1::app::::users::created_at");
    expect(keys.every((key) => key.endsWith("::created_at"))).toBe(true);
  });

  it("canonicalizes writes for unresolved query columns backed by mirrored tab metadata", () => {
    // A query column without a per-ordinal source mapping still inherits the
    // tab's tableMeta, whose MySQL schema slot mirrors the database.
    const keys = columnFormatterKeys({
      connectionId: "conn1",
      database: "app",
      databaseType: "mysql",
      resultColumn: "created_at",
      tableMeta: { database: "app", schema: "app", tableName: "users" },
    });
    expect(keys[0]).toBe("conn1::app::::users::created_at");
    expect(keys).toContain("conn1::app::app::users::created_at");
  });
});

describe("normalizeColumnFormatter", () => {
  it("preserves a structured manual reference filter", () => {
    expect(
      normalizeColumnFormatter({
        kind: "foreign-key-display",
        referenceMode: "manual",
        refSchema: " public ",
        refTable: " dictionary ",
        refColumn: " dict_key ",
        displayColumn: " dict_value ",
        filter: { column: " dict_type ", mode: "equals", value: " order_status " },
      }),
    ).toEqual({
      kind: "foreign-key-display",
      referenceMode: "manual",
      refSchema: "public",
      refTable: "dictionary",
      refColumn: "dict_key",
      displayColumn: "dict_value",
      filter: { column: "dict_type", mode: "equals", value: "order_status", endValue: undefined },
    });
  });

  it("rejects incomplete or unsupported manual reference filters", () => {
    const base = {
      kind: "foreign-key-display",
      referenceMode: "manual",
      refTable: "dictionary",
      refColumn: "dict_key",
      displayColumn: "dict_value",
    };
    expect(normalizeColumnFormatter({ ...base, filter: { column: "dict_type", mode: "equals", value: "" } })).toBeUndefined();
    expect(normalizeColumnFormatter({ ...base, filter: { column: "dict_type", mode: "between", value: "A" } })).toBeUndefined();
    expect(normalizeColumnFormatter({ ...base, filter: { column: "dict_type", mode: "raw-sql", value: "1=1" } })).toBeUndefined();
  });

  it.each(["is-blank", "is-not-blank"] as const)("preserves the value-less %s manual reference filter", (mode) => {
    expect(
      normalizeColumnFormatter({
        kind: "foreign-key-display",
        referenceMode: "manual",
        refTable: "dictionary",
        refColumn: "dict_key",
        displayColumn: "dict_value",
        filter: { column: "dict_type", mode },
      }),
    ).toMatchObject({ filter: { column: "dict_type", mode, value: undefined, endValue: undefined } });
  });
});

describe("normalizeSupportedDateTimePattern", () => {
  it("accepts the format grammar shared by the frontend and backend", () => {
    expect(normalizeSupportedDateTimePattern(" YYYY/M/D [at] HH:mm:ss.SSSZ ")).toBe("YYYY/M/D [at] HH:mm:ss.SSSZ");
  });

  it("rejects unsupported or malformed Day.js tokens", () => {
    expect(normalizeSupportedDateTimePattern("MM/DD/YYYY hh:mm A")).toBe("");
    expect(normalizeSupportedDateTimePattern("YYYY-MM-DD [at HH:mm:ss")).toBe("");
    expect(normalizeSupportedDateTimePattern("%Y-%m-%d")).toBe("");
  });
});

describe("defaultIoTDBTimestampFormatter", () => {
  it.each([
    ["ms", "1786954706123", "2026-08-17T16:18:26.123+08:00"],
    ["us", "1786954706123456", "2026-08-17T16:18:26.123456+08:00"],
    ["ns", "1786954706123456789", "2026-08-17T16:18:26.123456789+08:00"],
  ])("formats %s precision in the connection time zone without replacing the raw value", (precision, rawValue, expected) => {
    const formatter = defaultIoTDBTimestampFormatter("iotdb", `TIMESTAMP(${precision})`, "time_zone=Asia%2FShanghai");
    const row = [rawValue];

    expect(applyColumnFormatter(row[0], formatter)).toBe(expected);
    expect(row).toEqual([rawValue]);
  });

  it("does not guess when precision metadata is absent or invalid", () => {
    expect(defaultIoTDBTimestampFormatter("iotdb", "TIMESTAMP", "time_zone=Asia%2FShanghai")).toBeUndefined();
    expect(defaultIoTDBTimestampFormatter("iotdb", "TIMESTAMP(seconds)", "time_zone=Asia%2FShanghai")).toBeUndefined();
    expect(defaultIoTDBTimestampFormatter("mysql", "TIMESTAMP(ms)", "time_zone=Asia%2FShanghai")).toBeUndefined();
    expect(defaultIoTDBTimestampFormatter("iotdb", "INT64", "time_zone=Asia%2FShanghai")).toBeUndefined();
  });

  it("uses the IoTDB client session default when the connection does not specify a time zone", () => {
    const formatter = defaultIoTDBTimestampFormatter("iotdb", "TIMESTAMP(ms)", "");
    expect(applyColumnFormatter("1787759999000", formatter)).toBe("2026-08-26T23:59:59.000+08:00");
  });

  it("falls back to the IoTDB client session default for an invalid configured zone", () => {
    const formatter = defaultIoTDBTimestampFormatter("iotdb", "TIMESTAMP(ms)", "time_zone=Not%2FAZone");
    expect(applyColumnFormatter(1, formatter)).toBe("1970-01-01T08:00:00.001+08:00");
  });

  it("round-trips a negative nanosecond timestamp without truncating toward zero", () => {
    const formatter = defaultIoTDBTimestampFormatter("iotdb", "TIMESTAMP(ns)", "time_zone=UTC");
    const display = "1969-12-31T23:59:59.999999999+00:00";
    expect(applyColumnFormatter("-1", formatter)).toBe(display);
    expect(parseIoTDBTimestampEditorValue(display, "iotdb", "TIMESTAMP(ns)", "time_zone=UTC")).toBe("-1");
  });

  it.each([
    ["ms", "1786954706123", "2026-08-17T16:18:26.123+08:00"],
    ["us", "1786954706123456", "2026-08-17T16:18:26.123456+08:00"],
    ["ns", "1786954706123456789", "2026-08-17T16:18:26.123456789+08:00"],
  ])("round-trips %s precision through the temporal editor", (precision, rawValue, editorValue) => {
    const columnType = `TIMESTAMP(${precision})`;
    expect(formatIoTDBTimestampEditorValue(rawValue, "iotdb", columnType, "time_zone=Asia%2FShanghai")).toBe(editorValue);
    expect(parseIoTDBTimestampEditorValue(editorValue, "iotdb", columnType, "time_zone=UTC")).toBe(rawValue);
    expect(parseIoTDBTimestampEditorValue(editorValue.replace("T", " ").replace("+08:00", ""), "iotdb", columnType, "time_zone=Asia%2FShanghai")).toBe(rawValue);
  });

  it("keeps invalid and unrelated editor values on the generic path", () => {
    expect(parseIoTDBTimestampEditorValue("2026-02-30 10:00:00", "iotdb", "TIMESTAMP(ms)", "time_zone=Asia%2FShanghai")).toBeUndefined();
    expect(parseIoTDBTimestampEditorValue("2026-08-17 10:00:00.1234", "iotdb", "TIMESTAMP(ms)", "time_zone=Asia%2FShanghai")).toBeUndefined();
    expect(parseIoTDBTimestampEditorValue("2026-08-17 10:00:00", "mysql", "TIMESTAMP(ms)", "time_zone=Asia%2FShanghai")).toBeUndefined();
    expect(parseIoTDBTimestampEditorValue("2026-08-17 10:00:00", "iotdb", "TIMESTAMP", "time_zone=Asia%2FShanghai")).toBeUndefined();
  });
});

describe("forceCsvTextForTemporalColumns", () => {
  it("wraps only string values in temporal columns as force-text formulas", () => {
    const rows = [["2026-07-25 00:00:00.000", 48.962002, "root.a.b"]];
    const columnTypes = ["TIMESTAMP", "DOUBLE", "TEXT"];
    expect(forceCsvTextForTemporalColumns(rows, columnTypes)).toEqual([['="2026-07-25 00:00:00.000"', 48.962002, "root.a.b"]]);
  });

  it("leaves null and non-string temporal cells untouched", () => {
    const rows = [[null, 1700000000000]];
    const columnTypes = ["DATETIME", "DATETIME"];
    expect(forceCsvTextForTemporalColumns(rows, columnTypes)).toEqual([[null, 1700000000000]]);
  });

  it("returns shallow copies of rows when no column is temporal", () => {
    const rows = [["plain", 1]];
    const columnTypes = ["VARCHAR", "INT"];
    const result = forceCsvTextForTemporalColumns(rows, columnTypes);
    expect(result).toEqual(rows);
    expect(result[0]).not.toBe(rows[0]);
  });
});
