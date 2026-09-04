// Build-script view of `lib/i18n.ts`. The Next.js config is TypeScript, so the
// plain-JS build scripts keep their own copy; add a language in both places.
export const DEFAULT_LANGUAGE = "en";
export const LANGUAGES = ["en", "cn", "tr"];

/** Suffix a documentation page uses for a language: `faq.mdx` vs `faq.cn.mdx`. */
export function pageSuffix(language) {
  return language === DEFAULT_LANGUAGE ? ".mdx" : `.${language}.mdx`;
}

/** Navigation file for a language: `meta.json` vs `meta.cn.json`. */
export function metaFile(language) {
  return language === DEFAULT_LANGUAGE ? "meta.json" : `meta.${language}.json`;
}

/** Language a documentation file belongs to, from its filename. */
export function languageOfFile(file) {
  const match = file.match(/\.([a-z-]+)\.mdx$/);
  const language = match?.[1];
  return language && LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
}

/** Slug shared by every translation of a page. */
export function slugOfFile(file) {
  return file.replace(new RegExp(`(?:\\.(?:${LANGUAGES.join("|")}))?\\.mdx$`), "");
}
