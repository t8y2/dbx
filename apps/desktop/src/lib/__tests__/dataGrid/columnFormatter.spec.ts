import { describe, expect, it } from "vitest";
import { applyColumnFormatter, defaultIoTDBTimestampFormatter, formatIoTDBTimestampEditorValue, normalizeSupportedDateTimePattern, parseIoTDBTimestampEditorValue } from "@/lib/dataGrid/columnFormatter";

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
  it("formats epoch milliseconds in the connection time zone without replacing the raw value", () => {
    const rawValue = 1786954706123;
    const formatter = defaultIoTDBTimestampFormatter("iotdb", "TIMESTAMP", "time_zone=Asia%2FShanghai");

    expect(applyColumnFormatter(rawValue, formatter)).toBe("2026-08-17T16:18:26.123+08:00");
    expect(rawValue).toBe(1786954706123);
  });

  it("does not affect other databases or non-timestamp columns", () => {
    expect(defaultIoTDBTimestampFormatter("mysql", "TIMESTAMP", "time_zone=Asia%2FShanghai")).toBeUndefined();
    expect(defaultIoTDBTimestampFormatter("iotdb", "INT64", "time_zone=Asia%2FShanghai")).toBeUndefined();
  });

  it("uses UTC when the connection does not specify a time zone", () => {
    const formatter = defaultIoTDBTimestampFormatter("iotdb", "TIMESTAMP", "");
    expect(applyColumnFormatter(1, formatter)).toBe("1970-01-01T00:00:00.001+00:00");
  });

  it("round-trips the temporal editor through epoch milliseconds", () => {
    expect(formatIoTDBTimestampEditorValue(1786954706123, "iotdb", "TIMESTAMP", "time_zone=Asia%2FShanghai")).toBe("2026-08-17T16:18:26.123+08:00");
    expect(parseIoTDBTimestampEditorValue("2026-08-17 16:18:27.123", "iotdb", "TIMESTAMP", "time_zone=Asia%2FShanghai")).toBe(1786954707123);
    expect(parseIoTDBTimestampEditorValue("2026-08-17T16:18:27.123+08:00", "iotdb", "TIMESTAMP", "time_zone=UTC")).toBe(1786954707123);
  });

  it("keeps invalid and unrelated editor values on the generic path", () => {
    expect(parseIoTDBTimestampEditorValue("2026-02-30 10:00:00", "iotdb", "TIMESTAMP", "time_zone=Asia%2FShanghai")).toBeUndefined();
    expect(parseIoTDBTimestampEditorValue("2026-08-17 10:00:00", "mysql", "TIMESTAMP", "time_zone=Asia%2FShanghai")).toBeUndefined();
  });
});
