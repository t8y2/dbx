import { describe, expect, it } from "vitest";
import az from "../locales/az";
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
  ["az", az],
  ["en", en],
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

// The grid toolbar renders in whatever locale the user runs, so a missing key
// would leak a raw key next to the "load all" button.
const GRID_LOAD_ALL_KEYS = ["loadAllAndGoToLastRow", "allLoaded", "loadAllRowsConfirmTitle", "loadAllRowsConfirmMessage", "loadAllRowsContinue"] as const;

describe("grid load-all locale parity", () => {
  it.each(locales)("%s exposes the load-all copy", (_name, locale) => {
    const grid = (locale as { grid: Record<string, unknown> }).grid;
    for (const key of GRID_LOAD_ALL_KEYS) {
      expect(grid[key], `${_name}: grid.${key}`).toBeTypeOf("string");
      expect(grid[key] as string, `${_name}: grid.${key}`).not.toHaveLength(0);
    }
  });
});
