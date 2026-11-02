import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES,
  MAX_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES,
  WEB_DAV_LAST_SUCCESSFUL_SYNC_STORAGE_KEY,
  clearWebDavLastUploadAt,
  formatWebDavAutoUploadInterval,
  normalizedWebDavAutoUploadInterval,
  readWebDavLastSuccessfulSync,
  readWebDavLastUploadAt,
  recordWebDavSyncSuccess,
  writeWebDavAutoUploadFields,
  writeWebDavLastUploadAt,
} from "./webdavAutoUploadConfig";

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

describe("WebDAV last successful sync", () => {
  const target = { endpoint: "https://example.com/dav", username: " user ", remotePath: " DBX/sync/snapshot.json " };
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows the last success only for the matching WebDAV target", () => {
    const completedAt = "2026-10-13T09:30:00.000Z";
    recordWebDavSyncSuccess(target, completedAt);

    expect(readWebDavLastSuccessfulSync({ ...target, username: "user", remotePath: "DBX/sync/snapshot.json" })).toBe(completedAt);
    expect(readWebDavLastSuccessfulSync({ ...target, remotePath: "DBX/other/snapshot.json" })).toBeNull();
  });

  it("ignores malformed saved status", () => {
    values.set(WEB_DAV_LAST_SUCCESSFUL_SYNC_STORAGE_KEY, "not-json");

    expect(readWebDavLastSuccessfulSync(target)).toBeNull();
  });
});

describe("WebDAV last upload timestamp storage", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reads null when last upload timestamp is not stored or invalid", () => {
    const config = { endpoint: "https://dav.example.com" };
    expect(readWebDavLastUploadAt(config)).toBeNull();

    values.set("dbx-webdav-last-upload-at", "0");
    expect(readWebDavLastUploadAt(config)).toBeNull();

    values.set("dbx-webdav-last-upload-at", "-123");
    expect(readWebDavLastUploadAt(config)).toBeNull();

    values.set("dbx-webdav-last-upload-at", "not-a-number");
    expect(readWebDavLastUploadAt(config)).toBeNull();

    values.set("dbx-webdav-last-upload-at", JSON.stringify({ other: "invalid" }));
    expect(readWebDavLastUploadAt(config)).toBeNull();
  });

  it("reads and writes last upload timestamp bound to target", () => {
    const config = { endpoint: "https://dav.example.com" };
    const now = 1_700_000_000_000;
    writeWebDavLastUploadAt(config, now, false);
    expect(readWebDavLastUploadAt(config)).toBe(now);

    clearWebDavLastUploadAt(config, false);
    expect(readWebDavLastUploadAt(config)).toBeNull();
  });

  it("isolates upload timestamps across different endpoints, usernames, and remote paths", () => {
    const targetA = { endpoint: "https://dav.one.example.com", username: "userA", remotePath: "a.json" };
    const targetB = { endpoint: "https://dav.two.example.com", username: "userA", remotePath: "a.json" };
    const targetC = { endpoint: "https://dav.one.example.com", username: "userB", remotePath: "a.json" };
    const targetD = { endpoint: "https://dav.one.example.com", username: "userA", remotePath: "b.json" };

    writeWebDavLastUploadAt(targetA, 1_000, false);
    writeWebDavLastUploadAt(targetB, 2_000, false);

    expect(readWebDavLastUploadAt(targetA)).toBe(1_000);
    expect(readWebDavLastUploadAt(targetB)).toBe(2_000);
    expect(readWebDavLastUploadAt(targetC)).toBeNull();
    expect(readWebDavLastUploadAt(targetD)).toBeNull();

    clearWebDavLastUploadAt(targetA, false);
    expect(readWebDavLastUploadAt(targetA)).toBeNull();
    expect(readWebDavLastUploadAt(targetB)).toBe(2_000);
  });

  it("does not leak last upload timestamp when WebDAV endpoint changes", () => {
    const initialConfig = {
      endpoint: "https://dav.one.example.com",
      remotePath: "DBX/sync/snapshot.json",
    };
    writeWebDavAutoUploadFields(initialConfig, { enabled: true, intervalMinutes: 60 });
    writeWebDavLastUploadAt(initialConfig, 1_700_000_000_000, false);
    expect(readWebDavLastUploadAt()).toBe(1_700_000_000_000);

    // Same endpoint and remote path - timestamp preserved
    writeWebDavAutoUploadFields(initialConfig, { enabled: true, intervalMinutes: 120 });
    expect(readWebDavLastUploadAt()).toBe(1_700_000_000_000);

    // Changed endpoint - active config timestamp is null for new endpoint
    const newConfig = { ...initialConfig, endpoint: "https://dav.two.example.com" };
    writeWebDavAutoUploadFields(newConfig, { enabled: true, intervalMinutes: 120 });
    expect(readWebDavLastUploadAt()).toBeNull();
    // Previous config still retains its timestamp
    expect(readWebDavLastUploadAt(initialConfig)).toBe(1_700_000_000_000);
  });
});
