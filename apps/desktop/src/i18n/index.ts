import { createI18n } from "vue-i18n";
import en from "./locales/en";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/safeStorage";

export type Locale = "en" | "es" | "it" | "ja" | "pt-BR" | "zh-CN" | "zh-TW";
type LocaleMessages = Record<string, unknown>;
type I18nGlobal = {
  locale: { value: Locale };
  setLocaleMessage: (locale: Locale, messages: LocaleMessages) => void;
};

const supportedLocales: Locale[] = ["en", "es", "it", "ja", "pt-BR", "zh-CN", "zh-TW"];
const defaultLocale: Locale = "en";
const loadedLocales = new Set<Locale>([defaultLocale]);
const localeLoaders: Record<Exclude<Locale, "en">, () => Promise<{ default: LocaleMessages }>> = {
  es: () => import("./locales/es"),
  it: () => import("./locales/it"),
  ja: () => import("./locales/ja"),
  "pt-BR": () => import("./locales/pt-BR"),
  "zh-CN": () => import("./locales/zh-CN"),
  "zh-TW": () => import("./locales/zh-TW"),
};

export function normalizeLocale(value: string | null): Locale | null {
  if (value && supportedLocales.includes(value as Locale)) {
    return value as Locale;
  }
  return null;
}

export function localeFromLanguageTag(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const normalized = value.replace("_", "-").toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-")) {
    if (normalized.includes("hant") || normalized.startsWith("zh-tw") || normalized.startsWith("zh-hk") || normalized.startsWith("zh-mo")) {
      return "zh-TW";
    }
    return "zh-CN";
  }
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "es" || normalized.startsWith("es-")) return "es";
  if (normalized === "it" || normalized.startsWith("it-")) return "it";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt-BR";
  return null;
}

export function detectLocaleFromLanguages(languages: readonly string[]): Locale {
  for (const language of languages) {
    const locale = normalizeLocale(language) ?? localeFromLanguageTag(language);
    if (locale) return locale;
  }
  return defaultLocale;
}

function detectUserLocale(): Locale {
  try {
    const languages = globalThis.navigator?.languages;
    const language = globalThis.navigator?.language;
    const candidates = Array.isArray(languages) ? [...languages] : [];
    if (language) candidates.push(language);
    return detectLocaleFromLanguages(candidates);
  } catch {
    return defaultLocale;
  }
}

const savedLocale = normalizeLocale(safeLocalStorageGet("dbx-locale"));
const initialLocale = savedLocale ?? detectUserLocale();

const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: defaultLocale,
  messages: {
    en,
  },
});
const i18nGlobal = i18n.global as unknown as I18nGlobal;

export async function loadLocaleMessages(locale: Locale) {
  if (loadedLocales.has(locale)) return;
  const loader = localeLoaders[locale as Exclude<Locale, "en">];
  if (!loader) return;
  const messages = await loader();
  i18nGlobal.setLocaleMessage(locale, messages.default);
  loadedLocales.add(locale);
}

export async function loadSavedLocale() {
  await loadLocaleMessages(initialLocale);
}

export async function setLocale(locale: Locale) {
  await loadLocaleMessages(locale);
  i18nGlobal.locale.value = locale;
  safeLocalStorageSet("dbx-locale", locale);
}

export function currentLocale(): Locale {
  return i18nGlobal.locale.value;
}

export function nextLocale(current: Locale): Locale {
  const index = supportedLocales.indexOf(current);
  const nextIndex = index === -1 ? 0 : (index + 1) % supportedLocales.length;
  return supportedLocales[nextIndex];
}

export default i18n;
