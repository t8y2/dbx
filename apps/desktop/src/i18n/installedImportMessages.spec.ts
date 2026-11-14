// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import { installedImportMessages } from "./locales/installedImportMessages";

const localeModules = import.meta.glob<{ default: { installedImport: Record<string, string> } }>("./locales/*.ts");
const locales = Object.keys(installedImportMessages) as (keyof typeof installedImportMessages)[];
const uiSources = import.meta.glob<string>(["../components/config/InstalledConnectionsDialog.vue", "../components/layout/AppSidebar.vue", "../components/layout/WelcomeScreen.vue", "../composables/useDialogSources.ts"], { eager: true, query: "?raw", import: "default" });
const sources = Object.values(uiSources).join("\n");
const usedKeys = [...new Set([...sources.matchAll(/\bt\(["']installedImport\.([^"']+)["']/g)].map((match) => match[1]))];

describe("connection import translations", () => {
  it("covers every message used by the import dialog and its entry points", () => {
    expect(usedKeys.length).toBeGreaterThan(0);
    for (const key of usedKeys) expect(installedImportMessages.en).toHaveProperty(key);
  });

  it.each(locales)("registers complete native messages in the %s locale", async (locale) => {
    const messages = (await localeModules[`./locales/${locale}.ts`]()).default;
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } });
    expect(Object.keys(messages.installedImport).sort()).toEqual(Object.keys(installedImportMessages.en).sort());
    for (const key of usedKeys) {
      expect(i18n.global.te(`installedImport.${key}`, locale)).toBe(true);
      const translated = i18n.global.t(`installedImport.${key}`);
      expect(translated.trim().length).toBeGreaterThan(0);
      if (locale !== "en") expect(translated).not.toBe(installedImportMessages.en[key as keyof typeof installedImportMessages.en]);
    }
  });
});
