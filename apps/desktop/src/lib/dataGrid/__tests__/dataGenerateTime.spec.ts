import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGeneratorParams, generateValue } from "@/lib/dataGrid/dataGenerate";

// Exercise the production generator, not a copy of the time-range algorithm.
afterEach(() => vi.restoreAllMocks());

describe("time generation bounds", () => {
  it.each([
    ["00:00", "00:00", "00:00:00", "00:00:00", "00:00:00"],
    ["09:15", "09:20", "09:15:00", "09:17:30", "09:20:00"],
    ["09:15:10", "09:15:12", "09:15:10", "09:15:11", "09:15:12"],
    ["09", "09", "09:00:00", "09:30:00", "09:59:59"],
    ["09:20", "09:15", "09:15:00", "09:17:30", "09:20:00"],
    [undefined, undefined, "00:00:00", "12:00:00", "23:59:59"],
    ["invalid", "25:90", "00:00:00", "12:00:00", "23:59:59"],
  ])("honors %s..%s for time and daily datetime windows", (startTime, endTime, first, middle, last) => {
    for (const [random, expected] of [
      [0, first],
      [0.5, middle],
      [1 - Number.EPSILON, last],
    ] as const) {
      vi.spyOn(Math, "random").mockReturnValue(random);
      expect(generateValue("t", "time", "time", 1, { allDay: false, startTime, endTime })).toBe(expected);
      expect(generateValue("t", "datetime", "datetime", 1, { allDay: true, start: "2026-10-17", end: "2026-10-17", startTime, endTime })).toBe(`2026-10-17 ${expected}`);
    }
  });

  it("ignores custom bounds in the time generator's all-day mode", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(generateValue("t", "time", "time", 1, { allDay: true, startTime: "09:15", endTime: "09:20" })).toBe("12:00:00");
  });

  it("uses valid time input values for new configurations", () => {
    const params = defaultGeneratorParams("t", { dataType: "time", columnDefault: null }, "time");
    expect(params.startTime).toBe("00:00");
    expect(params.endTime).toBe("23:59");
  });
});
