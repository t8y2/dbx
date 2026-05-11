import { createI18n } from "vue-i18n";
import en from "./locales/en";
import es from "./locales/es";
import zhCN from "./locales/zh-CN";

export type Locale = "en" | "es" | "zh-CN";

const supportedLocales: Locale[] = ["en", "es", "zh-CN"];
const defaultLocale: Locale = "zh-CN";

function normalizeLocale(value: string | null): Locale {
  if (value && supportedLocales.includes(value as Locale)) {
    return value as Locale;
  }
  return defaultLocale;
}

const savedLocale = normalizeLocale(localStorage.getItem("dbx-locale"));

const i18n = createI18n({
  legacy: false,
  locale: savedLocale,
  fallbackLocale: "en",
  messages: {
    en,
    es,
    "zh-CN": zhCN,
  },
});

export function setLocale(locale: Locale) {
  i18n.global.locale.value = locale;
  localStorage.setItem("dbx-locale", locale);
}

export function currentLocale(): Locale {
  return i18n.global.locale.value as Locale;
}

export function nextLocale(current: Locale): Locale {
  const index = supportedLocales.indexOf(current);
  const nextIndex = index === -1 ? 0 : (index + 1) % supportedLocales.length;
  return supportedLocales[nextIndex];
}

export default i18n;
