import type { Locale } from "@/i18n";

export interface LocaleOption {
  value: Locale;
  flag: string;
  // Bundled SVGs avoid depending on system support for flag emoji (notably on Windows).
  flagIcon?: string;
  label: string;
}

export const LOCALE_OPTIONS: LocaleOption[] = [
  { value: "en", flag: "🇺🇸", flagIcon: "us", label: "English" },
  { value: "az", flag: "🇦🇿", flagIcon: "az", label: "Azərbaycan" },
  { value: "es", flag: "🇪🇸", flagIcon: "es", label: "Español" },
  { value: "id", flag: "🇮🇩", flagIcon: "id", label: "Bahasa Indonesia" },
  { value: "it", flag: "🇮🇹", flagIcon: "it", label: "Italiano" },
  { value: "ja", flag: "🇯🇵", flagIcon: "jp", label: "日本語" },
  { value: "ko", flag: "🇰🇷", flagIcon: "kr", label: "한국어" },
  { value: "pt-BR", flag: "🇧🇷", flagIcon: "br", label: "Português" },
  { value: "pl", flag: "🇵🇱", flagIcon: "pl", label: "Polski" },
  { value: "ru", flag: "🇷🇺", flagIcon: "ru", label: "Русский" },
  { value: "th", flag: "🇹🇭", flagIcon: "th", label: "ภาษาไทย" },
  { value: "tr", flag: "🇹🇷", flagIcon: "tr", label: "Türkçe" },
  { value: "zh-CN", flag: "🇨🇳", flagIcon: "cn", label: "简体中文" },
  { value: "zh-TW", flag: "繁", label: "繁體中文" },
];
