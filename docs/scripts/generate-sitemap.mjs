import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateSitemap, readHtmlPages } from "./seo.mjs";

const outputDirectory = resolve(import.meta.dirname, "../out");
const pages = await readHtmlPages(outputDirectory);
await writeFile(resolve(outputDirectory, "sitemap.xml"), generateSitemap(pages));
console.log(`sitemap.xml generated with ${pages.filter((page) => page.indexable).length} canonical URLs.`);
