import { describe, expect, it } from "vitest";
import en from "../locales/docs/en";
import es from "../locales/docs/es";
import it_ from "../locales/docs/it";
import ja from "../locales/docs/ja";
import ko from "../locales/docs/ko";
import ptBR from "../locales/docs/pt-BR";
import zhCN from "../locales/docs/zh-CN";
import zhTW from "../locales/docs/zh-TW";

// These import the per-locale DOCS modules, NOT ../locales/<name>.
//
// Every non-English locale file is `export default withEnglishFallback({...})`,
// which deep-merges `en` UNDER the locale at module level. Importing those
// default exports yields the ALREADY-MERGED object, so every locale appears to
// have every key and this test would pass while translations were missing —
// the fallback would silently defeat the test written to catch it.
const locales: Array<[string, Record<string, unknown>]> = [
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe("docs i18n namespace parity", () => {
  const expected = leafKeys(en as Record<string, unknown>).sort();

  it("english declares the docs namespace", () => {
    expect(expected.length, "locales/docs/en.ts must declare keys").toBeGreaterThan(0);
  });

  it.each(locales)("%s declares exactly the same docs keys as en", (_name, locale) => {
    expect(leafKeys(locale).sort()).toEqual(expected);
  });
});
