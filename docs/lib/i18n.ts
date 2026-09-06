import { defineI18n } from "fumadocs-core/i18n";
import { defineI18nUI } from "fumadocs-ui/i18n";

export const i18n = defineI18n({
  defaultLanguage: "en",
  languages: ["en", "cn", "tr"],
});

export const i18nUI = defineI18nUI(i18n, {
  en: { displayName: "English" },
  tr: {
    displayName: "Türkçe",
    search: "Ara",
    searchNoResult: "Sonuç bulunamadı",
    toc: "İçindekiler",
    tocNoHeadings: "Başlık yok",
    lastUpdate: "Son güncelleme",
    chooseLanguage: "Dil seçin",
    nextPage: "Sonraki sayfa",
    previousPage: "Önceki sayfa",
    chooseTheme: "Tema seçin",
    editOnGithub: "GitHub'da düzenle",
  },
  cn: {
    displayName: "简体中文",
    search: "搜索",
    searchNoResult: "没有找到结果",
    toc: "本页目录",
    tocNoHeadings: "没有目录",
    lastUpdate: "最后更新",
    chooseLanguage: "选择语言",
    nextPage: "下一页",
    previousPage: "上一页",
    chooseTheme: "选择主题",
    editOnGithub: "在 GitHub 上编辑",
  },
});

export type DocsLang = "en" | "cn" | "tr";

/**
 * Narrow an arbitrary route segment to a supported docs language.
 *
 * Pages keep their own `{ en, cn, tr }` copy objects; this replaces the
 * `lang === "cn" ? "cn" : "en"` ternary each of them used to repeat, so adding
 * a language only touches `i18n.languages` above.
 */
export function resolveLang(lang: string): DocsLang {
  return (i18n.languages as readonly string[]).includes(lang) ? (lang as DocsLang) : "en";
}
