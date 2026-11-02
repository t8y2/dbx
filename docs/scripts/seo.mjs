import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { LANGUAGES } from "./languages.mjs";

export const SITE_URL = "https://dbxio.com";

export function decodeHtml(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x[\da-f]+|#\d+);/gi, (entity) => {
    const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&#39;": "'" };
    const normalized = entity.toLowerCase();
    if (named[normalized]) return named[normalized];
    const codePoint = normalized.startsWith("&#x") ? parseInt(normalized.slice(3), 16) : parseInt(normalized.slice(2), 10);
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : "\uFFFD";
  });
}

export function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [match[1].toLowerCase(), decodeHtml(match[2] ?? match[3])]));
}

export function parseHtml(html) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const namedMeta = (name) => metas.filter((meta) => meta.name === name || meta.property === name);
  const robots = [...namedMeta("robots"), ...namedMeta("googlebot")].map((meta) => meta.content).join(",");
  return {
    title: decodeHtml(head.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    description: namedMeta("description").map((meta) => meta.content),
    canonicals: links.filter((link) => link.rel === "canonical").map((link) => link.href),
    alternates: links.filter((link) => link.rel === "alternate" && link.hreflang),
    markdown: links.find((link) => link.rel === "alternate" && link.type === "text/markdown")?.href,
    indexable: !/\b(?:noindex|none)\b/i.test(robots),
    openGraphUrl: namedMeta("og:url")[0]?.content,
    image: namedMeta("og:image")[0]?.content,
    imageAlt: namedMeta("og:image:alt")[0]?.content,
    lastModified: namedMeta("article:modified_time")[0]?.content,
    lang: attributes(html.match(/<html\b[^>]*>/i)?.[0] ?? "").lang,
    headings: [...html.matchAll(/<h1\b/gi)].length,
    main: /<main\b/i.test(html),
    structuredData: [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => JSON.parse(match[1])),
    hrefs: [...html.matchAll(/<a\b[^>]*>/gi)].map((match) => attributes(match[0]).href).filter(Boolean),
  };
}

export async function readHtmlPages(directory) {
  const pages = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".html")) {
        const path = `/${relative(directory, file)
          .replace(/\\/g, "/")
          .replace(/(?:\/index)?\.html$/, "")}`;
        if (!LANGUAGES.some((lang) => path === `/${lang}` || path.startsWith(`/${lang}/`))) continue;
        pages.push({ file, path, ...parseHtml(await readFile(file, "utf8")) });
      }
    }
  }
  await walk(directory);
  return pages.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

export function generateSitemap(pages) {
  const entries = pages
    .filter((page) => page.indexable)
    .map((page) => {
      const canonical = `${SITE_URL}${page.path}`;
      if (page.canonicals.length !== 1 || page.canonicals[0] !== canonical) {
        throw new Error(`${page.path}: sitemap requires a single self-referencing canonical`);
      }
      const lastModified = page.lastModified && Number.isFinite(Date.parse(page.lastModified)) ? `\n    <lastmod>${escapeXml(page.lastModified)}</lastmod>` : "";
      return `  <url>\n    <loc>${escapeXml(canonical)}</loc>${lastModified}\n${page.alternates.map((link) => `    <xhtml:link rel="alternate" hreflang="${escapeXml(link.hreflang)}" href="${escapeXml(link.href)}" />`).join("\n")}\n  </url>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join("\n")}\n</urlset>\n`;
}

export function auditPages(pages) {
  const errors = [];
  const pageMap = new Map(pages.map((page) => [`${SITE_URL}${page.path}`, page]));
  const titles = new Set();
  for (const page of pages) {
    if (!page.indexable) continue;
    const fail = (message) => errors.push(`${page.path}: ${message}`);
    const canonical = `${SITE_URL}${page.path}`;
    if (page.canonicals.length !== 1 || page.canonicals[0] !== canonical) fail("invalid canonical");
    if (!page.title.trim()) fail("missing title");
    const titleKey = `${page.lang}:${page.title}`;
    if (titles.has(titleKey)) fail("duplicate title in the same language");
    titles.add(titleKey);
    if (page.description.length !== 1 || !page.description[0]?.trim()) fail("missing or duplicate description");
    if (page.headings !== 1 || !page.main) fail("expected one H1 and a main landmark");
    if (page.lang !== (page.path.startsWith("/cn") ? "zh-CN" : "en")) fail("incorrect HTML language");
    if (page.openGraphUrl !== canonical || !page.image || !page.imageAlt) fail("incomplete Open Graph metadata");
    for (const language of ["en", "zh-CN", "x-default"]) {
      const alternates = page.alternates.filter((link) => link.hreflang === language);
      if (alternates.length !== 1) {
        fail(`expected one ${language} alternate`);
        continue;
      }
      const target = pageMap.get(alternates[0].href);
      if (!target?.indexable) fail(`${language} alternate is missing or noindex`);
      else if (language !== "x-default" && target.lang !== language) fail(`${language} alternate has wrong language`);
      else if (language === "x-default" && target.lang !== "en") fail("x-default must reference the English equivalent");
      else if (!target.alternates.some((link) => link.href === canonical && link.hreflang === page.lang)) fail(`${language} alternate is not reciprocal`);
    }
    for (const schema of page.structuredData) {
      if (schema["@type"] === "BreadcrumbList") {
        for (const entry of schema.itemListElement) {
          if (!pageMap.get(entry.item)?.indexable) fail(`breadcrumb points to a missing or noindex page: ${entry.item}`);
        }
      }
      if (schema["@type"] === "TechArticle" && (schema.url !== canonical || schema.mainEntityOfPage !== canonical)) fail("article identity does not match canonical");
    }
  }
  return errors;
}
