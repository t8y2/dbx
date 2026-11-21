import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `crypto.randomUUID` exists only in secure contexts, so every bare call in the
 * desktop/web bundle crashes under the plain-HTTP Docker deployment (issue #9306).
 * The guard-compatible forms — `crypto?.randomUUID?.()`, `globalThis.crypto?.randomUUID?.()`
 * — are allowed, as is the shared helper that owns the fallback.
 */
const SOURCE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HELPER_PATH = join("lib", "common", "utils.ts");
const BARE_CALL = /(?<!\?)crypto\s*\.\s*randomUUID\s*\(/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(path);
    return entry.endsWith(".ts") || entry.endsWith(".vue") ? [path] : [];
  });
}

describe("crypto.randomUUID call sites", () => {
  it("recognizes direct calls but not guard-compatible ones", () => {
    expect(BARE_CALL.test("const id = crypto.randomUUID();")).toBe(true);
    expect(BARE_CALL.test("globalThis.crypto.randomUUID()")).toBe(true);
    expect(BARE_CALL.test("crypto?.randomUUID?.() || fallback")).toBe(false);
    expect(BARE_CALL.test("globalThis.crypto?.randomUUID?.() ?? fallback")).toBe(false);
  });

  it("routes every UUID through the shared helper instead of calling crypto.randomUUID directly", () => {
    const offenders = sourceFiles(SOURCE_ROOT)
      .map((path) => ({ path: relative(SOURCE_ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") }))
      .filter(({ path }) => path !== HELPER_PATH.split(sep).join("/"))
      .filter(({ text }) => BARE_CALL.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
