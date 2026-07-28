import { CalendarDateTime, fromDate, getLocalTimeZone, parseDateTime, toCalendarDateTime } from "@internationalized/date";

const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The fields shared by CalendarDateTime and Vue's unwrapped representation of
 * it. Date values are normalized before calling methods that use private state.
 */
export interface CalendarDateTimeLike {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * Parses a local, timezone-free ISO date-time. Both `T` and a space are accepted
 * between the date and time, and an omitted seconds segment defaults to zero.
 */
export function parseLocalDateTime(value: string): CalendarDateTime | null {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value.trim());
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;

  try {
    return parseDateTime(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}`);
  } catch {
    return null;
  }
}

/** Formats a timezone-free value as the local ISO representation used by the picker. */
export function formatLocalDateTime(value: CalendarDateTimeLike): string {
  return [pad(value.year, 4), pad(value.month), pad(value.day)].join("-") + ` ${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`;
}

/**
 * Interprets the timezone-free wall-clock value in the DBX device's system time
 * zone before converting it to Unix seconds.
 */
export function calendarDateTimeToUnixSeconds(value: CalendarDateTimeLike): number {
  // DST gaps and overlaps do not identify exactly one local instant. Reject them
  // instead of silently changing the wall-clock time chosen by the user.
  return Math.floor(calendarDateTimeFromFields(value).toDate(getLocalTimeZone(), "reject").getTime() / 1_000);
}

/** True when a local wall-clock value identifies exactly one system-timezone instant. */
export function isValidLocalDateTime(value: CalendarDateTimeLike): boolean {
  try {
    calendarDateTimeToUnixSeconds(value);
    return true;
  } catch {
    return false;
  }
}

/** Converts Unix seconds to a timezone-free value in the DBX device's system time zone. */
export function unixSecondsToCalendarDateTime(seconds: number): CalendarDateTime {
  if (!Number.isFinite(seconds)) throw new RangeError("Unix seconds must be a finite number");

  const date = new Date(Math.trunc(seconds) * 1_000);
  if (Number.isNaN(date.getTime())) throw new RangeError("Unix seconds are outside the Date range");

  const local = toCalendarDateTime(fromDate(date, getLocalTimeZone()));
  return local.set({ millisecond: 0 });
}

export function currentLocalDateTime(): CalendarDateTime {
  return unixSecondsToCalendarDateTime(Math.floor(Date.now() / 1_000));
}

export function calendarDateTimeFromFields(value: CalendarDateTimeLike): CalendarDateTime {
  return new CalendarDateTime(value.year, value.month, value.day, value.hour, value.minute, value.second, value.millisecond);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
