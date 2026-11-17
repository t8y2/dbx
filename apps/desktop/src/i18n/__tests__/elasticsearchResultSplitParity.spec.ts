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
  ["pl", pl],
  ["pt-BR", ptBR],
  ["ru", ru],
  ["th", th],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

// The Elasticsearch result split view renders its toolbar in whatever locale
// the user runs, so a missing key would leak a raw key into the result pane.
const ES_RESULT_KEYS = ["viewSwitch", "documentsTab", "listTitle", "filterPlaceholder", "empty", "emptyFilter", "detailEmpty", "loading", "previous", "next", "range"] as const;

describe("elasticsearch result split view locale parity", () => {
  it.each(locales)("%s exposes the split view copy", (name, locale) => {
    const esResult = (locale as { esResult?: Record<string, unknown> }).esResult;
    expect(esResult, `${name}: esResult`).toBeDefined();
    for (const key of ES_RESULT_KEYS) {
      const value = esResult?.[key];
      expect(value, `${name}: esResult.${key}`).toBeTypeOf("string");
      expect(value as string, `${name}: esResult.${key}`).not.toHaveLength(0);
    }
  });

  it.each(locales)("%s keeps the range placeholders", (name, locale) => {
    const range = (locale as { esResult: Record<string, string> }).esResult.range;
    expect(range, `${name}: esResult.range`).toContain("{start}");
    expect(range, `${name}: esResult.range`).toContain("{end}");
  });
});
