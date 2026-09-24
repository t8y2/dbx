import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attributes, auditPages, decodeHtml, generateSitemap, parseHtml, readHtmlPages, SITE_URL } from "./seo.mjs";

function fixture(lang, suffix = "/docs") {
  const htmlLang = lang === "cn" ? "zh-CN" : "en";
  const path = `/${lang}${suffix}`;
  return {
    path,
    ...parseHtml(`<html lang="${htmlLang}"><head>
    <title>${lang} Documentation</title><meta name="description" content="DBX &amp; databases">
    <link rel="canonical" href="${SITE_URL}${path}">
    <link rel="alternate" hreflang="en" href="${SITE_URL}/en${suffix}">
    <link rel="alternate" hreflang="zh-CN" href="${SITE_URL}/cn${suffix}">
    <link rel="alternate" hreflang="x-default" href="${SITE_URL}/en${suffix}">
    <meta property="og:url" content="${SITE_URL}${path}">
    <meta property="og:image" content="${SITE_URL}/logo.png"><meta property="og:image:alt" content="DBX">
    </head><body><main><h1>Documentation</h1></main></body></html>`),
  };
}

test("extracts real head tags, decodes entities, and supports quoted attributes", () => {
  assert.deepEqual(attributes(`<link rel='canonical' href='https://example.com/?a=1&amp;b=2'>`), { rel: "canonical", href: "https://example.com/?a=1&b=2" });
  assert.equal(decodeHtml("&#x4e2d;&#25991; &quot;DBX&quot;"), '中文 "DBX"');
  assert.equal(decodeHtml("&AMP;&#X4E2D;&#99999999;"), "&中\uFFFD");
  assert.deepEqual(fixture("en").description, ["DBX & databases"]);
  assert.equal(parseHtml("<head><title>Real</title></head><body><title>Fake</title></body>").title, "Real");
});

test("accepts reciprocal, canonical, localized pages", () => {
  assert.deepEqual(auditPages([fixture("en"), fixture("cn")]), []);
});

test("rejects nonexistent translation targets", () => {
  assert.match(auditPages([fixture("en")]).join("\n"), /alternate is missing/);
});

test("rejects nonreciprocal translations", () => {
  const chinese = fixture("cn");
  chinese.alternates = chinese.alternates.filter((link) => link.hreflang !== "en");
  assert.match(auditPages([fixture("en"), chinese]).join("\n"), /not reciprocal/);
});

test("rejects missing breadcrumb targets and mismatched article identity", () => {
  const english = fixture("en");
  english.structuredData = [
    { "@type": "BreadcrumbList", itemListElement: [{ item: `${SITE_URL}/missing` }] },
    { "@type": "TechArticle", url: `${SITE_URL}/wrong` },
  ];
  const errors = auditPages([english, fixture("cn")]).join("\n");
  assert.match(errors, /breadcrumb points to a missing/);
  assert.match(errors, /article identity/);
});

test("rejects duplicate canonicals and multiple H1s", () => {
  const english = fixture("en");
  english.canonicals.push(english.canonicals[0]);
  english.headings = 2;
  assert.match(auditPages([english, fixture("cn")]).join("\n"), /invalid canonical/);
  assert.throws(() => generateSitemap([english]), /single self-referencing canonical/);
});

test("noindex pages are excluded from the sitemap, including future utility routes", () => {
  const page = { path: "/en/private", ...parseHtml('<head><meta name="googlebot" content="noindex, follow"></head>') };
  assert.equal(page.indexable, false);
  assert.equal(parseHtml('<head><meta name="robots" content="none"></head>').indexable, false);
  assert.doesNotMatch(generateSitemap([fixture("en"), page]), /private/);
});

test("sitemap uses HTML alternates and never invents lastmod", () => {
  const english = fixture("en");
  assert.doesNotMatch(generateSitemap([english]), /lastmod/);
  english.lastModified = "2026-09-22T08:00:00.000Z";
  const sitemap = generateSitemap([english]);
  assert.match(sitemap, /hreflang="zh-CN"/);
  assert.match(sitemap, /<lastmod>2026-09-22T08:00:00.000Z<\/lastmod>/);
});

test("sitemap XML escapes URLs", () => {
  const page = fixture("en");
  page.alternates[0].href = `${SITE_URL}/en?a=1&b=2`;
  assert.match(generateSitemap([page]), /a=1&amp;b=2/);
});

test("reads nested index exports while excluding root redirects, 404, and text routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dbx-seo-"));
  try {
    await mkdir(join(directory, "en/docs"), { recursive: true });
    await writeFile(join(directory, "en/docs/index.html"), '<html lang="en"><head></head></html>');
    await writeFile(join(directory, "404.html"), "missing");
    await writeFile(join(directory, "index.html"), "redirect");
    await writeFile(join(directory, "en/llms.txt"), "# Text");
    assert.deepEqual(
      (await readHtmlPages(directory)).map((page) => page.path),
      ["/en/docs"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
