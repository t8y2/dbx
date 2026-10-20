import { describe, expect, it } from "vitest";
import az from "../locales/az";
import en from "../locales/en";
import es from "../locales/es";
import id from "../locales/id";
import it_ from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import pl from "../locales/pl";
import ptBR from "../locales/pt-BR";
import ru from "../locales/ru";
import tr from "../locales/tr";
import th from "../locales/th";
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
  ["pl", pl],
  ["pt-BR", ptBR],
  ["ru", ru],
  ["tr", tr],
  ["th", th],
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
    expect(grid.copyExtractorRawHint, `${_name}: grid.copyExtractorRawHint`).toBeTypeOf("string");
    expect(grid.copyExtractorRawHint as string, `${_name}: grid.copyExtractorRawHint`).not.toHaveLength(0);
    expect(grid.copyExtractorAdvancedOptions, `${_name}: grid.copyExtractorAdvancedOptions`).toBeTypeOf("string");
    expect(grid.copyExtractorAdvancedOptions as string, `${_name}: grid.copyExtractorAdvancedOptions`).not.toHaveLength(0);
    for (const key of [
      "copyExtractorAdvancedCopy",
      "copyExtractorAdvancedCopyHint",
      "copyExtractorConfigureHint",
      "copyExtractorFormatList",
      "copyExtractorFormatOptions",
      "copyExtractorPreviewOnDemand",
      "copyExtractorCollapsePreview",
      "copyExtractorCopyFailed",
      "copyExtractorSelectionChanged",
      "copyExtractorCopyRunning",
    ]) {
      expect(grid[key], `${_name}: grid.${key}`).toBeTypeOf("string");
      expect(grid[key] as string, `${_name}: grid.${key}`).not.toHaveLength(0);
    }
  });
});
