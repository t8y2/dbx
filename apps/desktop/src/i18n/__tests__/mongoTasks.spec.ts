import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import en from "../locales/en";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

describe("Mongo task messages", () => {
  it.each([
    ["en", "Mongo tasks & schedules", "Running"],
    ["zh-CN", "Mongo 任务与调度", "运行中"],
    ["zh-TW", "Mongo 任務與排程", "執行中"],
  ])("loads task titles, statuses and confirmation parameters for %s", (locale, title, running) => {
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: "en", messages: { en, "zh-CN": zhCN, "zh-TW": zhTW } });
    expect(i18n.global.t("mongoTasks.title")).toBe(title);
    expect(i18n.global.t("mongoTasks.statuses.running")).toBe(running);
    expect(i18n.global.t("mongoTasks.runConfirm", { name: "daily-check", count: 3 })).toContain("daily-check");
    expect(i18n.global.t("mongoTasks.runConfirm", { name: "daily-check", count: 3 })).toContain("3");
    expect(i18n.global.t("mongoTasks.enableConfirm")).not.toContain("mongoTasks.");
  });
});
