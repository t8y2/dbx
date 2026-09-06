import { describe, expect, it } from "vitest";
import en from "../locales/en";
import es from "../locales/es";
import it_ from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import tr from "../locales/tr";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

const locales: Array<[string, Record<string, unknown>]> = [
  ["en", en as Record<string, unknown>],
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

function gridEntry(locale: Record<string, unknown>, key: string): unknown {
  const grid = locale["grid"];
  if (!grid || typeof grid !== "object") return undefined;
  return (grid as Record<string, unknown>)[key];
}

describe("table-info pin i18n messages", () => {
  it.each(["pinTableInfo", "unpinTableInfo"] as const)("en resolves grid.%s to text", (key) => {
    expect(gridEntry(en as Record<string, unknown>, key), `grid.${key} missing from locales/en.ts`).toBeTypeOf("string");
  });

  it.each(locales.slice(1))("%s translates table-info pin labels instead of using the English fallback", (_name, locale) => {
    for (const key of ["pinTableInfo", "unpinTableInfo"] as const) {
      const value = gridEntry(locale, key);
      expect(value, `${_name} grid.${key}`).toBeTypeOf("string");
      expect(value).not.toBe(gridEntry(en as Record<string, unknown>, key));
    }
  });
});
