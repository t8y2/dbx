import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import az from "@/i18n/locales/az";
import en from "@/i18n/locales/en";
import es from "@/i18n/locales/es";
import itLocale from "@/i18n/locales/it";
import ja from "@/i18n/locales/ja";
import ko from "@/i18n/locales/ko";
import ptBR from "@/i18n/locales/pt-BR";
import tr from "@/i18n/locales/tr";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";

describe("plugin batch messages", () => {
  it.each(Object.entries({ az, en, es, it: itLocale, ja, ko, "pt-BR": ptBR, tr, "zh-CN": zhCN, "zh-TW": zhTW }))("interpolates source conflicts and refresh errors in %s", (locale, messages) => {
    const pluginPlatform = messages.pluginPlatform as Pick<typeof en.pluginPlatform, "batchDuplicateSources" | "batchRefreshFailed">;
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: { pluginPlatform } } });
    expect(pluginPlatform.batchDuplicateSources.match(/\{[^}]+\}/g)).toEqual(["{names}"]);
    expect(pluginPlatform.batchRefreshFailed.match(/\{[^}]+\}/g)).toEqual(["{error}"]);
    expect(i18n.global.t("pluginPlatform.batchDuplicateSources", { names: "example.plugin" })).toContain("example.plugin");
    expect(i18n.global.t("pluginPlatform.batchRefreshFailed", { error: "refresh offline" })).toContain("refresh offline");
    i18n.dispose();
  });
});
