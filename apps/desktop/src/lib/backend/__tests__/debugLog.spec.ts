import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDebugLog, formatLocalTimestamp, formatLocalTimestampForFilename, formatLocalTimezoneOffset, getDebugLogText, padNumber } from "@/lib/backend/debugLog";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const DEBUG_LOG_ENABLED_KEY = "dbx-debug-logging-enabled";

let originalLocalStorage: PropertyDescriptor | undefined;

function expectedLocalOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, "0")}:${String(absoluteMinutes % 60).padStart(2, "0")}`;
}

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("debug log local timestamps", () => {
  it("pads date and time parts", () => {
    expect(padNumber(7)).toBe("07");
    expect(padNumber(35)).toBe("35");
    expect(padNumber(8, 3)).toBe("008");
  });

  it("formats timezone offsets in RFC 3339 style", () => {
    const east = new Date(0);
    const west = new Date(0);
    vi.spyOn(east, "getTimezoneOffset").mockReturnValue(-480);
    vi.spyOn(west, "getTimezoneOffset").mockReturnValue(420);

    expect(formatLocalTimezoneOffset(east)).toBe("+08:00");
    expect(formatLocalTimezoneOffset(west)).toBe("-07:00");
  });

  it("formats local timestamps with milliseconds and timezone", () => {
    const date = new Date(2026, 6, 8, 9, 50, 35, 882);

    expect(formatLocalTimestamp(date)).toBe(`2026-07-08T09:50:35.882${expectedLocalOffset(date)}`);
  });

  it("formats Windows-safe filename timestamp tokens", () => {
    const date = new Date(2026, 6, 8, 9, 50, 35, 882);
    const filenameToken = formatLocalTimestampForFilename(date);

    expect(filenameToken).toBe(`2026-07-08T09-50-35-882${expectedLocalOffset(date).replace(":", "-")}`);
    expect(filenameToken).not.toMatch(/[:.]/);
  });

  it("uses local timestamps in exported debug log text", () => {
    const date = new Date(2026, 6, 8, 9, 50, 35, 882);
    const timestamp = formatLocalTimestamp(date);
    vi.useFakeTimers();
    vi.setSystemTime(date);
    localStorage.setItem(DEBUG_LOG_ENABLED_KEY, "1");

    appendDebugLog("info", "hello");

    const text = getDebugLogText();
    expect(text).toContain(`Exported: ${timestamp}`);
    expect(text).toContain(`[${timestamp}] [INFO] hello`);
    expect(text).not.toContain(".882Z");
  });
});
