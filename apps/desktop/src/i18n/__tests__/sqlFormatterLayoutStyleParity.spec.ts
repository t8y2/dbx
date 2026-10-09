import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every locale must declare the SQL formatter layout-style strings in its own
 * source file, not fall back to English. The check has to read the raw source:
 * each non-en locale is wrapped in `withEnglishFallback(...)`, which deep-merges
 * `en` under the locale at import time, so asserting on the imported modules
 * would report the key as present even after a locale drops it.
 */
const LOCALE_FILES = ["az", "en", "es", "id", "it", "ja", "ko", "pt-BR", "ru", "tr", "zh-CN", "zh-TW"];

const LAYOUT_STYLE_KEYS = ["sqlFormatterLayoutStyle", "sqlFormatterLayoutStyleDbx", "sqlFormatterLayoutStyleClassic"];

function localeSource(name: string): string {
  return readFileSync(new URL(`../locales/${name}.ts`, import.meta.url), "utf8");
}

function declaredString(source: string, key: string): string | undefined {
  return source.match(new RegExp(String.raw`^\s*${key}:\s*"((?:[^"\\]|\\.)*)",\s*$`, "m"))?.[1];
}

describe("SQL formatter layout style i18n parity", () => {
  it.each(LOCALE_FILES)("%s declares every layout-style key in its source", (name) => {
    const source = localeSource(name);
    for (const key of LAYOUT_STYLE_KEYS) {
      expect(declaredString(source, key), `${name} is missing ${key}`).toBeTruthy();
    }
  });

  it.each(LOCALE_FILES)("%s anchors the cluster after the indent-style keys", (name) => {
    const source = localeSource(name);
    const anchor = source.indexOf("sqlFormatterIndentStyleTabularRight:");
    const layoutStyle = source.indexOf("sqlFormatterLayoutStyle:");

    expect(anchor).toBeGreaterThan(-1);
    expect(layoutStyle).toBeGreaterThan(anchor);
  });

  it("en carries the labels the settings panel shows", () => {
    const source = localeSource("en");

    expect(declaredString(source, "sqlFormatterLayoutStyle")).toBe("Layout style");
    expect(declaredString(source, "sqlFormatterLayoutStyleDbx")).toBe("DBX (default)");
    expect(declaredString(source, "sqlFormatterLayoutStyleClassic")).toBe("Classic");
  });

  it("zh-CN translates the labels instead of leaving them in English", () => {
    const source = localeSource("zh-CN");

    expect(declaredString(source, "sqlFormatterLayoutStyle")).toBe("排版风格");
    expect(declaredString(source, "sqlFormatterLayoutStyleClassic")).toContain("经典");
  });
});
