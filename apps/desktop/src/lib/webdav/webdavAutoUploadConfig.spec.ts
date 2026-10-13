import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES, MAX_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES, formatWebDavAutoUploadInterval, normalizedWebDavAutoUploadInterval } from "./webdavAutoUploadConfig";

const zhCnUnits = { minute: "分钟", hour: "小时", day: "天" };

describe("WebDAV auto-upload interval", () => {
  it("keeps configured intervals in minutes and accepts up to one year", () => {
    expect(normalizedWebDavAutoUploadInterval(90)).toBe(90);
    expect(normalizedWebDavAutoUploadInterval(MAX_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES + 1)).toBe(MAX_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES);
    expect(normalizedWebDavAutoUploadInterval("invalid")).toBe(DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES);
  });

  it.each([
    [30, "30 分钟", false],
    [60, "1 小时", false],
    [90, "1 小时 30 分钟", false],
    [95, "1 小时 35 分钟", false],
    [1439, "23 小时 59 分钟", false],
    [1440, "1 天", false],
    [1441, "1 天 1 分钟", false],
    [1530, "1 天 1 小时 30 分钟", false],
  ])("formats %i minutes as a readable interval", (minutes, interval, approximate) => {
    expect(formatWebDavAutoUploadInterval(minutes, "zh-CN", zhCnUnits)).toEqual({ interval, approximate });
  });
});

describe("WebDAV last upload timestamp storage", () => {
  let restoreStorage: (() => void) | undefined;

  function installStorage() {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
        clear: () => store.clear(),
      },
    });
    return () => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    };
  }

  beforeEach(() => {
    restoreStorage = installStorage();
  });

  afterEach(() => {
    restoreStorage?.();
    restoreStorage = undefined;
  });

  it("reads null when last upload timestamp is not stored or invalid", async () => {
    const { readWebDavLastUploadAt } = await import("./webdavAutoUploadConfig");
    expect(readWebDavLastUploadAt()).toBeNull();

    localStorage.setItem("dbx-webdav-last-upload-at", "0");
    expect(readWebDavLastUploadAt()).toBeNull();

    localStorage.setItem("dbx-webdav-last-upload-at", "-123");
    expect(readWebDavLastUploadAt()).toBeNull();

    localStorage.setItem("dbx-webdav-last-upload-at", "not-a-number");
    expect(readWebDavLastUploadAt()).toBeNull();
  });

  it("reads and writes last upload timestamp", async () => {
    const { readWebDavLastUploadAt, writeWebDavLastUploadAt, clearWebDavLastUploadAt } = await import("./webdavAutoUploadConfig");
    const now = 1_700_000_000_000;
    writeWebDavLastUploadAt(now, false);
    expect(readWebDavLastUploadAt()).toBe(now);

    clearWebDavLastUploadAt(false);
    expect(readWebDavLastUploadAt()).toBeNull();
  });

  it("clears last upload timestamp if WebDAV endpoint or remotePath changes", async () => {
    const { readWebDavLastUploadAt, writeWebDavLastUploadAt, writeWebDavAutoUploadFields } = await import("./webdavAutoUploadConfig");
    const initialConfig = {
      endpoint: "https://dav.one.example.com",
      remotePath: "DBX/sync/snapshot.json",
    };
    writeWebDavAutoUploadFields(initialConfig, { enabled: true, intervalMinutes: 60 });
    writeWebDavLastUploadAt(1_700_000_000_000, false);
    expect(readWebDavLastUploadAt()).toBe(1_700_000_000_000);

    // Same endpoint and remote path - timestamp preserved
    writeWebDavAutoUploadFields(initialConfig, { enabled: true, intervalMinutes: 120 });
    expect(readWebDavLastUploadAt()).toBe(1_700_000_000_000);

    // Changed endpoint - timestamp cleared
    writeWebDavAutoUploadFields({ ...initialConfig, endpoint: "https://dav.two.example.com" }, { enabled: true, intervalMinutes: 120 });
    expect(readWebDavLastUploadAt()).toBeNull();
  });
});
