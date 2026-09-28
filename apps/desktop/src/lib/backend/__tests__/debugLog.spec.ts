import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDebugLog, clearDebugLogs, formatLocalTimestamp, formatLocalTimestampForFilename, formatLocalTimezoneOffset, getDebugLogText, padNumber } from "@/lib/backend/debugLog";

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
  clearDebugLogs();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("debug log write batching", () => {
  it("does not rewrite the stored buffer on every appended entry", () => {
    vi.useFakeTimers();
    localStorage.setItem(DEBUG_LOG_ENABLED_KEY, "1");
    const setItem = vi.spyOn(localStorage, "setItem");

    for (let index = 0; index < 200; index += 1) appendDebugLog("info", `entry-${index}`);

    const entryWrites = () => setItem.mock.calls.filter(([key]) => key === "dbx-debug-log-entries");
    expect(entryWrites().length).toBe(0);
    // Pending entries are readable before they are persisted.
    expect(getDebugLogText()).toContain("entry-199");

    vi.advanceTimersByTime(250);

    const writes = entryWrites();
    expect(writes.length).toBe(1);
    const stored = JSON.parse(String(writes[0][1])) as { message: string }[];
    expect(stored.length).toBe(200);
    expect(stored[199].message).toContain("entry-199");
  });

  it("persists error entries without waiting for the flush delay", () => {
    vi.useFakeTimers();
    localStorage.setItem(DEBUG_LOG_ENABLED_KEY, "1");
    const setItem = vi.spyOn(localStorage, "setItem");

    appendDebugLog("error", "boom");

    const writes = setItem.mock.calls.filter(([key]) => key === "dbx-debug-log-entries");
    expect(writes.length).toBe(1);
    expect(String(writes[0][1])).toContain("boom");
  });

  it("re-reads the stored buffer when it changes underneath the cache", () => {
    localStorage.setItem(DEBUG_LOG_ENABLED_KEY, "1");
    localStorage.setItem("dbx-debug-log-entries", JSON.stringify([{ timestamp: "t", level: "info", message: "external" }]));

    appendDebugLog("info", "local");

    const text = getDebugLogText();
    expect(text).toContain("external");
    expect(text).toContain("local");
  });
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

  it("redacts Consul and nested identity-provider secrets", () => {
    localStorage.setItem(DEBUG_LOG_ENABLED_KEY, "1");
    appendDebugLog("error", {
      SecretID: "acl-secret",
      peering_token: "peering-secret",
      nested: { OIDCClientSecret: "oidc-secret", safe: "visible" },
    });

    const text = getDebugLogText();
    expect(text).not.toContain("acl-secret");
    expect(text).not.toContain("peering-secret");
    expect(text).not.toContain("oidc-secret");
    expect(text).toContain("visible");
  });
});
