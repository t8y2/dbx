import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en";
import es from "@/i18n/locales/es";
import itLocale from "@/i18n/locales/it";
import ja from "@/i18n/locales/ja";
import ko from "@/i18n/locales/ko";
import ptBR from "@/i18n/locales/pt-BR";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";

type Messages = {
  customType: typeof en.customType;
  contextMenu: typeof en.contextMenu;
};

const locales = { es, it: itLocale, ja, ko, "pt-BR": ptBR, "zh-CN": zhCN, "zh-TW": zhTW } as unknown as Record<string, Messages>;

describe("custom type translations", () => {
  it("provides localized labels in every supported non-English locale", () => {
    for (const [localeName, messages] of Object.entries(locales)) {
      expect(messages.customType.kinds.composite, localeName).not.toBe(en.customType.kinds.composite);
      expect(messages.customType.tabs.properties, localeName).not.toBe(en.customType.tabs.properties);
      expect(messages.customType.members.empty, localeName).not.toBe(en.customType.members.empty);
      expect(messages.customType.properties.empty, localeName).not.toBe(en.customType.properties.empty);
      expect(messages.customType.ddl.empty, localeName).not.toBe(en.customType.ddl.empty);
      expect(messages.customType.ddl.incomplete, localeName).not.toBe(en.customType.ddl.incomplete);
      expect(messages.contextMenu.viewDetails, localeName).not.toBe(en.contextMenu.viewDetails);
    }
  });
});
