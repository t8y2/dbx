import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES, MAX_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES, WEB_DAV_LAST_SUCCESSFUL_SYNC_STORAGE_KEY, formatWebDavAutoUploadInterval, normalizedWebDavAutoUploadInterval, readWebDavLastSuccessfulSync, recordWebDavSyncSuccess } from "./webdavAutoUploadConfig";

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
