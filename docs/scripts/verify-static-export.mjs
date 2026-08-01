import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = fileURLToPath(new URL("../out/", import.meta.url));
const scannedExtensions = new Set([".html", ".js", ".txt"]);
const forbiddenEndpoint = "api.github.com";

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (scannedExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }

  return files;
}

const files = await collectFiles(outputDirectory);
const violations = [];

for (const file of files) {
  if ((await readFile(file, "utf8")).includes(forbiddenEndpoint)) {
    violations.push(relative(outputDirectory, file));
  }
}

if (violations.length > 0) {
  throw new Error(`Static export contains browser-visible GitHub API endpoints:\n${violations.join("\n")}`);
}

console.log(`Static export verified: ${files.length} files contain no GitHub API endpoints.`);

const requiredContent = [
  { file: "en.html", includes: ['<html lang="en"', '"@type":"SoftwareApplication"'] },
  { file: "cn.html", includes: ['<html lang="zh-CN"', '"@type":"SoftwareApplication"'] },
  { file: "llms.txt", includes: ["70+ database", "20 MB", "Apache-2.0"] },
];

for (const requirement of requiredContent) {
  const content = await readFile(join(outputDirectory, requirement.file), "utf8");
  for (const expected of requirement.includes) {
    if (!content.includes(expected)) {
      throw new Error(`${requirement.file} is missing required static content: ${expected}`);
    }
  }

  if (content.includes('"potentialAction"')) {
    throw new Error(`${requirement.file} advertises a search action that the static site does not provide.`);
  }
}

console.log("Static export metadata verified for language, software schema, and llms.txt accuracy.");

const localizedHtmlFiles = files.filter(
  (file) =>
    extname(file) === ".html" &&
    ["en", "cn"].some(
      (lang) => file === join(outputDirectory, `${lang}.html`) || file.startsWith(`${join(outputDirectory, lang)}${sep}`),
    ),
);

for (const file of localizedHtmlFiles) {
  const content = await readFile(file, "utf8");
  const relativePath = relative(outputDirectory, file);

  for (const landmark of ["<main", "<h1"]) {
    if (!content.includes(landmark)) {
      throw new Error(`${relativePath} is missing required semantic landmark: ${landmark}>`);
    }
  }
}

console.log(`Static export semantics verified for ${localizedHtmlFiles.length} localized pages.`);

const sitemap = await readFile(join(outputDirectory, "sitemap.xml"), "utf8");
for (const localizedHome of ["https://dbxio.com/en", "https://dbxio.com/cn"]) {
  if (!sitemap.includes(`<loc>${localizedHome}</loc>`)) {
    throw new Error(`sitemap.xml is missing localized URL: ${localizedHome}`);
  }
}

console.log("Static export sitemap verified with independent English and Chinese URLs.");
