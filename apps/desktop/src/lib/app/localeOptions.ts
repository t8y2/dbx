import type { Locale } from "@/i18n";

export const LOCALE_OPTIONS: { value: Locale; flag: string; label: string }[] = [
  { value: "en", flag: "🇺🇸", label: "English" },
  { value: "es", flag: "🇪🇸", label: "Español" },
  { value: "it", flag: "🇮🇹", label: "Italiano" },
  { value: "ja", flag: "🇯🇵", label: "日本語" },
  { value: "pt-BR", flag: "🇧🇷", label: "Português" },
  { value: "zh-CN", flag: "🇨🇳", label: "简体中文" },
  { value: "zh-TW", flag: "繁", label: "繁體中文" },
];
