import { readdirSync, writeFileSync } from "fs";
import { resolve, relative } from "path";

const OUT_DIR = resolve(import.meta.dirname, "../out");
const SITE_URL = "https://dbxio.com";
const TODAY = new Date().toISOString().split("T")[0];

const EXCLUDE = new Set(["index.html", "404.html", "_not-found.html"]);

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
  return !EXCLUDE.has(basename);
});

const pagesByPath = new Map();

for (const file of htmlFiles) {
  const url = pathToUrl(file);
  const match = url.match(/^\/(en|cn)(\/.*)?$/);
  if (!match) {
    pagesByPath.set(url, { en: null, cn: null });
    continue;
  }
  const relativePath = match[2] || "/";
  if (!pagesByPath.has(relativePath)) {
    pagesByPath.set(relativePath, { en: null, cn: null });
  }
  const entry = pagesByPath.get(relativePath);
  entry[match[1]] = url;
  pagesByPath.set(relativePath, entry);
}

const urls = [];
const seen = new Set();

for (const [, langs] of pagesByPath) {
  const primary = langs.en || langs.cn;
  if (!primary || seen.has(primary)) continue;
  seen.add(primary);

  const altLinks = [];
  if (langs.en) {
    altLinks.push({ lang: "en", href: `${SITE_URL}${langs.en}` });
  }
  if (langs.cn) {
    altLinks.push({ lang: "zh", href: `${SITE_URL}${langs.cn}` });
  }

  if (altLinks.length > 1) {
    altLinks.push({ lang: "x-default", href: `${SITE_URL}${langs.en}` });
  }

  urls.push({ loc: `${SITE_URL}${primary}`, lastmod: TODAY, altLinks });
}

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls
  .map(
    (entry) =>
      `  <url>
    <loc>${entry.loc}</loc>
    <lastmod>${entry.lastmod}</lastmod>
${entry.altLinks.map((alt) => `    <xhtml:link rel="alternate" hreflang="${alt.lang}" href="${alt.href}" />`).join("\n")}
  </url>`,
  )
  .join("\n")}
</urlset>
`;

writeFileSync(resolve(OUT_DIR, "sitemap.xml"), sitemapXml);
console.log(`sitemap.xml generated with ${urls.length} URLs`);
