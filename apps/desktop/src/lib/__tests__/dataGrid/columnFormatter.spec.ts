import { describe, expect, it } from "vitest";
import { applyColumnFormatter, defaultIoTDBTimestampFormatter, formatIoTDBTimestampEditorValue, normalizeColumnFormatter, normalizeSupportedDateTimePattern, parseIoTDBTimestampEditorValue } from "@/lib/dataGrid/columnFormatter";

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

  it("uses UTC when the connection does not specify a time zone", () => {
    const formatter = defaultIoTDBTimestampFormatter("iotdb", "TIMESTAMP(ms)", "");
    expect(applyColumnFormatter(1, formatter)).toBe("1970-01-01T00:00:00.001+00:00");
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
