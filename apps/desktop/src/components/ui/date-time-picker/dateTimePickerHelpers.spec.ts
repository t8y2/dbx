import { CalendarDateTime, resetLocalTimeZone, setLocalTimeZone } from "@internationalized/date";
import { afterEach, describe, expect, it } from "vitest";
import { calendarDateTimeToUnixSeconds, formatLocalDateTime, isValidLocalDateTime, parseLocalDateTime, unixSecondsToCalendarDateTime } from "./dateTimePicker";

afterEach(() => {
  resetLocalTimeZone();
});

describe("local date-time helpers", () => {
  it("parses local ISO text with a space or T separator at second precision", () => {
    const space = parseLocalDateTime("2024-02-29 13:45:06");
    const t = parseLocalDateTime("2024-02-29T13:45");

    expect(space && formatLocalDateTime(space)).toBe("2024-02-29 13:45:06");
    expect(t && formatLocalDateTime(t)).toBe("2024-02-29 13:45:00");
  });

  it("rejects empty, malformed, and impossible local date-times", () => {
    expect(parseLocalDateTime("")).toBeNull();
    expect(parseLocalDateTime("2024-02-30 12:00:00")).toBeNull();
    expect(parseLocalDateTime("2024-01-01T24:00:00")).toBeNull();
    expect(parseLocalDateTime("2024-01-01 12:00:00Z")).toBeNull();
  });

  it("converts through the local timezone rather than treating the wall-clock value as UTC", () => {
    setLocalTimeZone("America/Los_Angeles");
    const local = new CalendarDateTime(2024, 1, 15, 12, 34, 56);
    const seconds = calendarDateTimeToUnixSeconds(local);

    expect(new Date(seconds * 1_000).toISOString()).toBe("2024-01-15T20:34:56.000Z");
    expect(formatLocalDateTime(unixSecondsToCalendarDateTime(seconds))).toBe("2024-01-15 12:34:56");
  });

  it("rejects local times that are skipped or repeated by daylight-saving transitions", () => {
    setLocalTimeZone("America/Los_Angeles");
    const skipped = new CalendarDateTime(2024, 3, 10, 2, 30, 0);
    const repeated = new CalendarDateTime(2024, 11, 3, 1, 30, 0);

    expect(isValidLocalDateTime(skipped)).toBe(false);
    expect(isValidLocalDateTime(repeated)).toBe(false);
    expect(() => calendarDateTimeToUnixSeconds(skipped)).toThrow();
    expect(() => calendarDateTimeToUnixSeconds(repeated)).toThrow();
  });
});
