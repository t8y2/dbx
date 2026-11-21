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
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

describe("ROWID update conflict locale parity", () => {
  it.each(locales)("%s exposes update-conflict feedback", (_name, locale) => {
    const grid = (locale as { grid: Record<string, unknown> }).grid;
    expect(grid.rowIdUpdateConflict).toBeTypeOf("string");
    expect(grid.rowIdUpdateConflict).not.toHaveLength(0);
    expect(grid.rowIdUpdateConflict).not.toBe("grid.rowIdUpdateConflict");
  });
});
