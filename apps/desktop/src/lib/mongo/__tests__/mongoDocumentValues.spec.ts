import { describe, expect, it } from "vitest";
import type { ColumnFormatterConfig } from "@/lib/dataGrid/columnFormatter";
import { mongoDocumentGridClipboardText, mongoDocumentGridColumnTypes, mongoDocumentGridDisplayText, mongoDocumentGridEditorText, mongoDocumentGridExternalValue, mongoDocumentGridValue } from "@/lib/mongo/mongoDocumentValues";

function dateFormatter(timezone: string | undefined): ColumnFormatterConfig {
  return { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD HH:mm:ss", timezone };
}

describe("MongoDB document date display", () => {
  it("infers top-level Extended JSON dates as temporal columns", () => {
    expect(mongoDocumentGridColumnTypes([{ createdAt: { $date: "2026-09-24T02:00:00.000Z" } }], ["createdAt"])).toEqual(["datetime"]);
    expect(mongoDocumentGridColumnTypes([{ createdAt: { $date: { $numberLong: "1790215200000" } } }], ["createdAt"])).toEqual(["datetime"]);
  });

  it("preserves mixed numeric column inference", () => {
    expect(mongoDocumentGridColumnTypes([{ value: { $numberInt: "1" } }, { value: { $numberLong: "2" } }], ["value"])).toEqual(["number"]);
  });

  it("formats top-level dates in UTC and IANA time zones", () => {
    const value = mongoDocumentGridValue({ $date: "2026-09-24T02:00:00.000Z" });
    expect(mongoDocumentGridDisplayText(value, dateFormatter("UTC"))).toBe("2026-09-24 02:00:00");
    expect(mongoDocumentGridDisplayText(value, dateFormatter("Asia/Shanghai"))).toBe("2026-09-24 10:00:00");
  });

  it("formats nested dates without changing non-date BSON values", () => {
    const value = mongoDocumentGridValue({ event: { at: { $date: "2026-09-24T02:00:00.000Z" }, sequence: { $numberLong: "9007199254740993" } }, tags: ["a"] });
    expect(mongoDocumentGridDisplayText(value, dateFormatter("Asia/Shanghai"))).toBe('{"event":{"at":"2026-09-24 10:00:00","sequence":{"$numberLong":"9007199254740993"}},"tags":["a"]}');
  });

  it("uses local time when no timezone override is configured", () => {
    const value = mongoDocumentGridValue({ $date: "2026-09-24T02:00:00.000Z" });
    expect(mongoDocumentGridDisplayText(value, dateFormatter(undefined))).toMatch(/^2026-09-2[34] \d{2}:00:00$/);
  });

  it("falls back to the original Extended JSON for an invalid timezone", () => {
    const value = mongoDocumentGridValue({ nested: { $date: "2026-09-24T02:00:00.000Z" } });
    expect(mongoDocumentGridDisplayText(value, dateFormatter("Invalid/Timezone"))).toBe('{"nested":{"$date":"2026-09-24T02:00:00.000Z"}}');
  });

  it("keeps edit, copy, and external values independent from display formatting", () => {
    const original = { createdAt: { $date: "2026-09-24T02:00:00.000Z" }, nested: [{ $date: "2026-09-24T03:00:00.000Z" }] };
    const value = mongoDocumentGridValue(original) as string;
    const rawJson = JSON.stringify(original);
    expect(mongoDocumentGridDisplayText(value, dateFormatter("Asia/Shanghai"))).not.toBe(rawJson);
    expect(mongoDocumentGridEditorText(value)).toBe(rawJson);
    expect(mongoDocumentGridClipboardText(value)).toBe(rawJson);
    expect(mongoDocumentGridExternalValue(value)).toBe(rawJson);
  });

  it("does not reinterpret a BSON string that merely looks like Extended JSON", () => {
    const value = mongoDocumentGridValue('{"$date":"2026-09-24T02:00:00.000Z"}') as string;
    expect(mongoDocumentGridDisplayText(value, dateFormatter("Asia/Shanghai"))).toBeUndefined();
  });
});
