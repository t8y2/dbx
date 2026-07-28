import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
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
