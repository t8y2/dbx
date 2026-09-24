import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { auditPages, generateSitemap, readHtmlPages, SITE_URL } from "./seo.mjs";

const outputDirectory = resolve(import.meta.dirname, "../out");
const pages = await readHtmlPages(outputDirectory);
const errors = auditPages(pages);
const index = await readFile(resolve(outputDirectory, "llms.txt"), "utf8");
const fullText = await readFile(resolve(outputDirectory, "llms-full.txt"), "utf8");
const sitemap = await readFile(resolve(outputDirectory, "sitemap.xml"), "utf8");
if (sitemap !== generateSitemap(pages)) errors.push("sitemap differs from the canonical HTML metadata");

for (const page of pages.filter((entry) => entry.indexable)) {
  const image = new URL(page.image, SITE_URL);
  if (image.origin === SITE_URL) {
    try {
      await stat(resolve(outputDirectory, `.${image.pathname}`));
    } catch {
      errors.push(`${page.path}: missing social image ${image.pathname}`);
    }
  }
  if (!/^\/(en|cn)\/docs(?:\/|$)/.test(page.path)) continue;
  const canonical = `${SITE_URL}${page.path}`;
  if (!page.markdown || !page.markdown.startsWith(`${SITE_URL}/`)) {
    errors.push(`${page.path}: missing Markdown alternate`);
    continue;
  }
  const markdown = new URL(page.markdown).pathname;
  try {
    const content = await readFile(resolve(outputDirectory, `.${markdown}`), "utf8");
    if (!content.includes(`Source: ${canonical}`) || !content.startsWith("# ")) errors.push(`${page.path}: invalid Markdown provenance`);
    if (!index.includes(page.markdown) || !fullText.includes(`Source: ${canonical}\n`)) errors.push(`${page.path}: missing from LLM index or full text`);
  } catch {
    errors.push(`${page.path}: Markdown alternate does not exist at ${markdown}`);
  }
  for (const href of page.hrefs) {
    const target = new URL(href, canonical);
    if (target.origin !== SITE_URL || !/^\/(en|cn)\/docs(?:\/|$)/.test(target.pathname)) continue;
    if (!pages.some((candidate) => candidate.path === target.pathname.replace(/\/+$/, ""))) errors.push(`${page.path}: broken documentation link ${href}`);
  }
}

if (errors.length) throw new Error(`SEO verification failed:\n${errors.join("\n")}`);
console.log(`SEO verified: ${pages.filter((page) => page.indexable).length} indexable pages, reciprocal hreflang, canonical sitemap, linked data, and documentation Markdown coverage.`);
