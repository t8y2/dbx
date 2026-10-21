import { describe, expect, it } from "vitest";
import az from "../locales/az";
import en from "../locales/en";
import es from "../locales/es";
import id from "../locales/id";
import it_ from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import ru from "../locales/ru";
import th from "../locales/th";
import tr from "../locales/tr";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

const locales: Array<[string, Record<string, unknown>]> = [
  ["az", az],
  ["en", en],
  ["es", es],
  ["id", id],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["ru", ru],
  ["th", th],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

// The grid display-settings panel renders in whatever locale the user runs, so a
// missing key would leak a raw key next to the boolean value-style control.
const GRID_BOOLEAN_VALUE_STYLE_KEYS = ["booleanValueStyle", "booleanValueTrueFalse", "booleanValueZeroOne"] as const;

describe("grid boolean value style locale parity", () => {
  it.each(locales)("%s exposes the boolean value-style copy", (_name, locale) => {
    const grid = (locale as { grid: Record<string, unknown> }).grid;
    for (const key of GRID_BOOLEAN_VALUE_STYLE_KEYS) {
      expect(grid[key], `${_name}: grid.${key}`).toBeTypeOf("string");
      expect(grid[key] as string, `${_name}: grid.${key}`).not.toHaveLength(0);
    }
  });
});
