import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import en from "../locales/en";
import zhCN from "../locales/zh-CN";

describe.each(["en", "zh-CN"])("PL debugger messages (%s)", (locale) => {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: "en", messages: { en, "zh-CN": zhCN } });

  it("resolves the shared workspace and value interaction messages", () => {
    for (const key of [
      "toolbar.resume",
      "toolbar.restart",
      "watch.add",
      "variables.emptyString",
      "variables.unread",
      "variables.noStop",
      "variables.resizeName",
      "variables.resetWidth",
      "variables.copyName",
      "variables.copyValue",
      "variables.expandValue",
      "variables.copied",
      "sql.hint",
      "outcome.empty",
    ]) {
      const path = `plDebug.${key}`;
      expect(i18n.global.t(path)).not.toBe(path);
    }
  });

  it("keeps original names and error details in localized feedback", () => {
    expect(i18n.global.t("plDebug.variables.expandName", { name: '"Mixed.Name"' })).toContain('"Mixed.Name"');
    expect(i18n.global.t("plDebug.variables.readbackFailed", { error: "GET response lost" })).toContain("GET response lost");
    expect(i18n.global.t("plDebug.variables.copyFailed", { error: "clipboard denied" })).toContain("clipboard denied");
  });
});
