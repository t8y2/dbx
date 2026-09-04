import { readdirSync, writeFileSync } from "fs";
import { resolve, relative } from "path";
import { DEFAULT_LANGUAGE, LANGUAGES } from "./languages.mjs";

const OUT_DIR = resolve(import.meta.dirname, "../out");
const SITE_URL = "https://dbxio.com";
const EXCLUDE = new Set(["index.html", "404.html", "_not-found.html"]);
const EXCLUDE_PATHS = new Set(LANGUAGES.map((language) => `/${language}/issue`));
// hreflang codes differ from the route segment for locales whose segment is not
// already a language code.
const HREFLANG = { en: "en", cn: "zh", tr: "tr" };

function* walkDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      yield fullPath;
    }
  }
}

function pathToUrl(filePath) {
  const rel = relative(OUT_DIR, filePath);
  return "/" + rel.replace(/\.html$/, "").replace(/\\/g, "/");
}

const htmlFiles = [...walkDir(OUT_DIR)].filter((f) => {
  const basename = f.split("/").pop() ?? "";
  return !EXCLUDE.has(basename) && !EXCLUDE_PATHS.has(pathToUrl(f));
});

function emptyLanguageMap() {
  return Object.fromEntries(LANGUAGES.map((language) => [language, null]));
}

const pagesByPath = new Map();

for (const file of htmlFiles) {
  const url = pathToUrl(file);
  const match = url.match(new RegExp(`^/(${LANGUAGES.join("|")})(/.*)?$`));
  if (!match) {
    pagesByPath.set(url, emptyLanguageMap());
    continue;
  }
  const relativePath = match[2] || "/";
  if (!pagesByPath.has(relativePath)) {
    pagesByPath.set(relativePath, emptyLanguageMap());
  }
  const entry = pagesByPath.get(relativePath);
  entry[match[1]] = url;
  pagesByPath.set(relativePath, entry);
}

const urls = [];
const seen = new Set();

for (const [, langs] of pagesByPath) {
  const localizedPages = LANGUAGES.map((language) => langs[language]).filter(Boolean);
  if (localizedPages.length === 0) continue;

  const altLinks = LANGUAGES.filter((language) => langs[language]).map((language) => ({
    lang: HREFLANG[language] ?? language,
    href: `${SITE_URL}${langs[language]}`,
  }));

  if (altLinks.length > 1 && langs[DEFAULT_LANGUAGE]) {
    altLinks.push({ lang: "x-default", href: `${SITE_URL}${langs[DEFAULT_LANGUAGE]}` });
  }

  for (const localizedPage of localizedPages) {
    if (seen.has(localizedPage)) continue;
    seen.add(localizedPage);
    urls.push({ loc: `${SITE_URL}${localizedPage}`, altLinks });
  }
}

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls
  .map(
    (entry) =>
      `  <url>
    <loc>${entry.loc}</loc>
${entry.altLinks.map((alt) => `    <xhtml:link rel="alternate" hreflang="${alt.lang}" href="${alt.href}" />`).join("\n")}
  </url>`,
  )
  .join("\n")}
</urlset>
`;

writeFileSync(resolve(OUT_DIR, "sitemap.xml"), sitemapXml);
console.log(`sitemap.xml generated with ${urls.length} URLs`);
