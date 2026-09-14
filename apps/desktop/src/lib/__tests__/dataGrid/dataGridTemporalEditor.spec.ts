import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTemporalInputValue, hostTimezoneOffsetSuffix, parseTemporalInputValue, stepTemporalInputValue, temporalCellEditorConfig, temporalCellEditorKind } from "@/lib/dataGrid/dataGridTemporalEditor";

describe("dataGridTemporalEditor", () => {
  it("resolves temporal editor configs with fractional precision", () => {
    expect(temporalCellEditorConfig("datetime(3)")).toEqual({ kind: "datetime", fractionPrecision: 3 });
    expect(temporalCellEditorConfig("datetime2(7)")).toEqual({ kind: "datetime", fractionPrecision: 7 });
    expect(temporalCellEditorConfig("timestamp(6)")).toEqual({ kind: "datetime", fractionPrecision: 6 });
    expect(temporalCellEditorConfig("time(6)")).toEqual({ kind: "time", fractionPrecision: 6 });
    expect(temporalCellEditorConfig("DateTime64(3)")).toEqual({ kind: "datetime", fractionPrecision: 3 });
  });

  it("uses column numeric scale for temporal fractional precision", () => {
    expect(temporalCellEditorConfig({ data_type: "timestamp", numeric_scale: 6 })).toEqual({ kind: "datetime", fractionPrecision: 6 });
    expect(temporalCellEditorConfig({ data_type: "time", numeric_scale: 3 })).toEqual({ kind: "time", fractionPrecision: 3 });
    expect(temporalCellEditorConfig({ data_type: "timestamp(6)", numeric_scale: 2 })).toEqual({ kind: "datetime", fractionPrecision: 2 });
  });

  it("keeps the legacy kind-only helper", () => {
    expect(temporalCellEditorKind("datetime(6)")).toBe("datetime");
    expect(temporalCellEditorKind("date")).toBe("date");
    expect(temporalCellEditorKind("varchar(64)")).toBeUndefined();
  });

  it("preserves fractional seconds when formatting and parsing datetime input", () => {
    expect(formatTemporalInputValue("2026-07-09 12:34:56.123456", "datetime")).toBe("2026-07-09T12:34:56.123456");
    expect(parseTemporalInputValue("2026-07-09T12:34:56.123456", "datetime")).toBe("2026-07-09 12:34:56.123456");
  });

  it("preserves fractional seconds when formatting and parsing time input", () => {
    expect(formatTemporalInputValue("12:34:56.123456", "time")).toBe("12:34:56.123456");
    expect(parseTemporalInputValue("12:34:56.123456", "time")).toBe("12:34:56.123456");
  });

  it("preserves fractional seconds while stepping date and time parts", () => {
    const value = "2026-07-09 12:34:56.123456";

    expect(stepTemporalInputValue(value, "datetime", "day", 1)).toBe("2026-07-10 12:34:56.123456");
    expect(stepTemporalInputValue(value, "datetime", "hour", 1)).toBe("2026-07-09 13:34:56.123456");
    expect(stepTemporalInputValue(value, "datetime", "second", 1)).toBe("2026-07-09 12:34:57.123456");
  });

  it("preserves timezone offsets when parsing or stepping temporal values", () => {
    const datetime = "2026-07-09 12:34:56.123456+12:00";
    const time = "12:34:56.123456-05:30";

    expect(parseTemporalInputValue(time, "time")).toBe(time);
    expect(stepTemporalInputValue(datetime, "datetime", "hour", 1)).toBe("2026-07-09 13:34:56.123456+12:00");
    expect(stepTemporalInputValue(time, "time", "minute", 1)).toBe("12:35:56.123456-05:30");
  });

  it("keeps ordinary datetime values at second precision", () => {
    expect(temporalCellEditorConfig("datetime")).toEqual({ kind: "datetime", fractionPrecision: 0 });
    expect(formatTemporalInputValue("2026-07-09 12:34:56", "datetime")).toBe("2026-07-09T12:34:56");
    expect(parseTemporalInputValue("2026-07-09T12:34:56", "datetime")).toBe("2026-07-09 12:34:56");
  });

  it("formats the host timezone offset for tz-aware Now values", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    const spy = vi.spyOn(Date.prototype, "getTimezoneOffset");

    try {
      spy.mockReturnValue(-480);
      expect(hostTimezoneOffsetSuffix(now)).toBe("+08:00");

      spy.mockReturnValue(330);
      expect(hostTimezoneOffsetSuffix(now)).toBe("-05:30");

      spy.mockReturnValue(0);
      expect(hostTimezoneOffsetSuffix(now)).toBe("+00:00");
    } finally {
      spy.mockRestore();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
