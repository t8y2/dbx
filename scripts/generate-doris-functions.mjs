import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Input: an Apache doris-website checkout containing the versioned SQL manuals.
const docsRoot = process.argv[2];
if (!docsRoot) throw new Error("Usage: node scripts/generate-doris-functions.mjs /path/to/doris-website");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = execFileSync("git", ["-C", docsRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith(".md") ? [path] : [];
  });
}

function definitions(version) {
  const root = join(docsRoot, `versioned_docs/version-${version}/sql-manual/sql-functions`);
  return files(root).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1];
    const metadata = frontmatter ? parse(frontmatter) : {};
    const name = String(metadata?.title ?? "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || metadata?.draft || name === "OVERVIEW" || relative(root, path).startsWith("combinators/")) return [];
    const syntax = /##+\s+Syntax\s*\n([\s\S]*?)(?=\n##|$)/i.exec(text)?.[1] ?? "";
    const code = [...syntax.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)].map((match) => match[1] ?? match[2]);
    const signatures = [
      ...new Set(
        code.flatMap((block) => {
          const matches = [...block.matchAll(new RegExp(`\\b${name}\\s*\\(`, "gi"))];
          return matches.flatMap((match) => {
            const start = match.index;
            let depth = 1;
            let end = start + match[0].length;
            while (end < block.length && depth > 0) {
              if (block[end] === "(") depth++;
              if (block[end] === ")") depth--;
              end++;
            }
            return depth === 0 ? [block.slice(start, end).replace(/\s+/g, " ")] : [];
          });
        }),
      ),
    ];
    const category = relative(root, dirname(path)).replaceAll("\\", "/");
    const document = relative(root, path).replaceAll("\\", "/").replace(/\.md$/, "");
    return [{ name, category, signatures, docs: `https://doris.apache.org/docs/${version}/sql-manual/sql-functions/${document}/` }];
  });
}

const older = new Map(definitions("2.1").map((definition) => [definition.name, definition]));
const current = new Map(definitions("3.x").map((definition) => [definition.name, definition]));
const entries = [...current.values()].map((definition) => ({ ...definition, documentedIn: older.has(definition.name) ? ["2.1", "3.x"] : ["3.x"] }));
for (const definition of older.values()) {
  if (!current.has(definition.name)) entries.push({ ...definition, documentedIn: ["2.1"] });
}
entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
const output = { source: "https://github.com/apache/doris-website", revision, license: "Apache-2.0", functions: entries };
writeFileSync(join(repoRoot, "apps/desktop/src/lib/sql/doris/functions.generated.json"), JSON.stringify(output, null, 2) + "\n");
console.log(`Generated ${entries.length} Doris functions from ${revision}`);
