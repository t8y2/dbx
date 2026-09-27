import { describe, expect, it } from "vitest";
import az from "../locales/az";
import en from "../locales/en";
import es from "../locales/es";
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
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["ru", ru],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

// Saving an extractor configuration closes the dialog and toasts a confirmation,
// so every locale that ships the extractor dialog needs this key or the toast
// would render a raw key.
describe("grid copy extractor saved locale parity", () => {
  it.each(locales)("%s exposes the extractor-saved copy", (_name, locale) => {
    const grid = (locale as { grid: Record<string, unknown> }).grid;
    expect(grid.copyExtractorSaved, `${_name}: grid.copyExtractorSaved`).toBeTypeOf("string");
    expect(grid.copyExtractorSaved as string, `${_name}: grid.copyExtractorSaved`).not.toHaveLength(0);
  });
});
