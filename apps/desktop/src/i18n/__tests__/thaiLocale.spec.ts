// @vitest-environment happy-dom

import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n, { detectLocaleFromLanguages, localeFromLanguageTag, normalizeLocale, setLocale } from "@/i18n";
import { LOCALE_OPTIONS } from "@/lib/app/localeOptions";
import en from "../locales/en";
import th from "../locales/th";

describe("Thai locale", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
  });

  afterEach(async () => {
    await setLocale("en");
    storage.clear();
  });

  it("registers Thai detection and the language menu option", () => {
    expect(normalizeLocale("th")).toBe("th");
    expect(localeFromLanguageTag("th_TH")).toBe("th");
    expect(detectLocaleFromLanguages(["fr-FR", "th-TH"])).toBe("th");
    expect(detectLocaleFromLanguages(["fr-FR"])).toBe("en");
    expect(LOCALE_OPTIONS).toContainEqual({ value: "th", flag: "🇹🇭", label: "ภาษาไทย" });
  });

  it("compiles and interpolates Thai through Vue I18n", () => {
    const i18n = createI18n({
      legacy: false,
      locale: "th",
      fallbackLocale: false,
      messages: { en, th },
    });

    const message = i18n.global.t("sidebarMenu.customizeTitle", { scope: "Table" });
    expect(message).toContain("Table");
    expect(message).not.toContain("{scope}");
    expect(message).not.toBe(en.sidebarMenu.customizeTitle);
  });

  it("renders Thai literal JSON braces with fallback disabled", () => {
    const localI18n = createI18n({ legacy: false, locale: "th", fallbackLocale: false, messages: { th } });
    expect(localI18n.global.t("contextMenu.createMongoIndexFilterInvalid")).toBe('Partial Filter ต้องเป็น Object เช่น { "status": "active" }');
  });

  it("renders Thai literal pipe examples with fallback disabled", () => {
    const localI18n = createI18n({ legacy: false, locale: "th", fallbackLocale: false, messages: { th } });
    const placeholder = localI18n.global.t("connection.sqliteExtensionsPlaceholder");
    const hint = localI18n.global.t("connection.sqliteExtensionsHint");
    const tableFilterExample = localI18n.global.t("schemaDiff.tableFilterHelpExample");

    expect(placeholder, "th: sqliteExtensionsPlaceholder").toContain("|sqlite3_text_init");
    expect(hint, "th: sqliteExtensionsHint").toContain("|");
    expect(tableFilterExample, "th: tableFilterHelpExample").toContain("a|b");
    expect(`${placeholder}\n${hint}\n${tableFilterExample}`).not.toContain("{'|'}");
  });

  it("localizes the combined sidebar comment and object-size mode", () => {
    expect(th.settings.sidebarObjectInfoModeCommentAndSize).toBe("คอมเมนต์ + ขนาดออบเจ็กต์");
    expect(th.settings.sidebarObjectInfoModeDescription).toContain("ทั้งสองอย่าง");
    expect(th.settings.sidebarObjectInfoModeDescription).not.toContain("ใช้พร้อมกันไม่ได้");
  });

  it("loads Thai lazily and persists an explicit selection", async () => {
    globalThis.localStorage.clear();
    await setLocale("th");
    expect(globalThis.localStorage.getItem("dbx-locale")).toBe("th");
    expect(i18n.global.locale.value).toBe("th");
    expect(i18n.global.t("common.save")).toBe("บันทึก");
  });
});
