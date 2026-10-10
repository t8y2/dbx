import { describe, expect, it } from "vitest";
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
    [90, "1.5 小时", false],
    [95, "1.58 小时", true],
    [1440, "1 天", false],
    [1530, "1 天 1.5 小时", false],
  ])("formats %i minutes as a readable interval", (minutes, interval, approximate) => {
    expect(formatWebDavAutoUploadInterval(minutes, "zh-CN", zhCnUnits)).toEqual({ interval, approximate });
  });
});
