import { describe, expect, it } from "vitest";
import { formatTemporalInputValue, parseTemporalInputValue, stepTemporalInputValue, temporalCellEditorConfig, temporalCellEditorKind } from "@/lib/dataGrid/dataGridTemporalEditor";

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

  it("keeps ordinary datetime values at second precision", () => {
    expect(temporalCellEditorConfig("datetime")).toEqual({ kind: "datetime", fractionPrecision: 0 });
    expect(formatTemporalInputValue("2026-07-09 12:34:56", "datetime")).toBe("2026-07-09T12:34:56");
    expect(parseTemporalInputValue("2026-07-09T12:34:56", "datetime")).toBe("2026-07-09 12:34:56");
  });
});
