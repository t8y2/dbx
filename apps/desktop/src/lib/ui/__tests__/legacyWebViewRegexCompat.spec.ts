import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_EXTENSIONS = new Set([".ts", ".vue"]);
// Workspace sources that ship in the WebView bundle. Named capture groups
// (`(?<name>…)`) are fine — Safari 10.1+ supports them; lookbehind
// (`(?<=…)` / `(?<!…)`) is not — old WebKit (< Safari 16.4, e.g. macOS 12)
// throws "invalid group specifier name" while *parsing the module*, which
// kills the whole app at startup (issues #6521 and #8202), so guard every
// bundled source, not just the file that regressed last time.
const BUNDLED_SOURCE_ROOTS = ["apps/desktop/src", "packages/mongo-shell/src"];

function collectSourceFiles(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "__tests__" || entry.startsWith(".")) continue;
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      collectSourceFiles(fullPath, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

const workspaceRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../../../..");
const bundledSources = BUNDLED_SOURCE_ROOTS.flatMap((relativeRoot) => collectSourceFiles(path.join(workspaceRoot, relativeRoot)));

// The runtime feature probe in legacyWebView.ts constructs its lookbehind
// from a string inside try/catch (module still parses on old WebKit; the
// engine that throws is the one being detected), so it is the sole allowed
// exception.
const LOOKBEHIND_ALLOWLIST = new Set(["apps/desktop/src/lib/ui/legacyWebView.ts"]);

describe("WebView startup sources stay compatible with old WebKit regex syntax", () => {
  it("ships no lookbehind assertions in bundled sources", () => {
    expect(bundledSources.length).toBeGreaterThan(1000);

    const offenders = bundledSources
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return source.includes("(?<=") || source.includes("(?<!");
      })
      .map((file) => path.relative(workspaceRoot, file))
      .filter((relative) => !LOOKBEHIND_ALLOWLIST.has(relative));
    expect(offenders).toEqual([]);
  });
});
