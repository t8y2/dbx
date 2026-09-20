import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en";
import es from "@/i18n/locales/es";
import itLocale from "@/i18n/locales/it";
import ja from "@/i18n/locales/ja";
import ko from "@/i18n/locales/ko";
import ptBR from "@/i18n/locales/pt-BR";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";

type ViewMessages = {
  contextMenu: { compileObjectFailedTitle: string; compileObjectFailedMessage: string };
  objects: { validStatus: string; invalidStatus: string };
};

const locales = { en, es, it: itLocale, ja, ko, "pt-BR": ptBR, "zh-CN": zhCN, "zh-TW": zhTW } as unknown as Record<string, ViewMessages>;

describe.each(Object.entries(locales))("Dameng view messages: %s", (localeName, messages) => {
  it("provides a localized compilation failure with both placeholders", () => {
    expect(messages.contextMenu.compileObjectFailedTitle).toBeTypeOf("string");
    expect(messages.contextMenu.compileObjectFailedMessage).toContain("{name}");
    expect(messages.contextMenu.compileObjectFailedMessage).toContain("{message}");
    expect(messages.contextMenu.compileObjectFailedMessage).toContain("\n");
    if (localeName !== "en") expect(messages.contextMenu.compileObjectFailedTitle).not.toBe(en.contextMenu.compileObjectFailedTitle);
  });

  it("preserves the database validity labels", () => {
    expect(messages.objects.validStatus).toBe("VALID");
    expect(messages.objects.invalidStatus).toBe("INVALID");
  });
});
