import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en";
import es from "@/i18n/locales/es";
import itLocale from "@/i18n/locales/it";
import ja from "@/i18n/locales/ja";
import ko from "@/i18n/locales/ko";
import ptBR from "@/i18n/locales/pt-BR";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";

describe("user administration Host translations", () => {
  it("provides the Host-change labels in English", () => {
    expect(en.userAdmin.changeHost).toEqual(expect.any(String));
    expect(en.userAdmin.newHost).toEqual(expect.any(String));
  });

  it("provides localized Host-change labels in every non-English locale", () => {
    const locales = { es, it: itLocale, ja, ko, "pt-BR": ptBR, "zh-CN": zhCN, "zh-TW": zhTW };
    for (const [locale, messages] of Object.entries(locales)) {
      expect(messages.userAdmin.changeHost, locale).not.toBe(en.userAdmin.changeHost);
      expect(messages.userAdmin.newHost, locale).not.toBe(en.userAdmin.newHost);
    }
  });
});
