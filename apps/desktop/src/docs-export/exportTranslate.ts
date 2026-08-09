import en from "@/i18n/locales/docs/en";
import es from "@/i18n/locales/docs/es";
import it from "@/i18n/locales/docs/it";
import ja from "@/i18n/locales/docs/ja";
import ko from "@/i18n/locales/docs/ko";
import ptBR from "@/i18n/locales/docs/pt-BR";
import zhCN from "@/i18n/locales/docs/zh-CN";
import zhTW from "@/i18n/locales/docs/zh-TW";
import type { Translate } from "@/docs/docsWarnings";

export const EXPORT_LOCALES = { en, es, it, ja, ko, "pt-BR": ptBR, "zh-CN": zhCN, "zh-TW": zhTW } as const;

export type ExportLocale = keyof typeof EXPORT_LOCALES;

function lookup(source: unknown, key: string): string | null {
  const value = key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), source);
  return typeof value === "string" ? value : null;
}

/**
 * Build a `Translate` over a bundled namespace.
 *
 * English is the fallback rather than the raw key. The parity test guarantees
 * all 8 namespaces agree, so this should never fire — it exists so an
 * artefact opened offline degrades to English instead of showing
 * `docs.columns` to a reader. This is not the Part 3b hazard where a fallback
 * masked drift: there the fallback replaced the guard, here the guard runs in
 * CI and this is only a runtime backstop.
 */
export function createExportTranslate(lang: ExportLocale): Translate {
  const primary = EXPORT_LOCALES[lang] ?? EXPORT_LOCALES.en;
  return (key, params) => {
    // Keys arrive prefixed with `docs.` because that is how the namespace is
    // mounted in the app; the bundled modules are the namespace itself.
    const bare = key.startsWith("docs.") ? key.slice("docs.".length) : key;
    const template = lookup(primary, bare) ?? lookup(EXPORT_LOCALES.en, bare);
    if (template === null) return key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
  };
}
