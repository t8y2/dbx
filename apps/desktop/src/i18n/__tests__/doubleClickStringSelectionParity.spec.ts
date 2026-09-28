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

// The editor settings page renders in whatever locale the user runs, so a
// missing key would show a raw key on the "double click inside a string" row.
const DOUBLE_CLICK_STRING_KEYS = ["doubleClickStringSelectionMode", "doubleClickStringSelectionModeDescription", "doubleClickStringSelectionModeContent", "doubleClickStringSelectionModeWord"] as const;

describe("double-click string selection locale parity", () => {
  it.each(locales)("%s exposes the double-click string copy", (_name, locale) => {
    const settings = (locale as { settings: Record<string, unknown> }).settings;
    for (const key of DOUBLE_CLICK_STRING_KEYS) {
      expect(settings[key], `${_name}: settings.${key}`).toBeTypeOf("string");
      expect(settings[key] as string, `${_name}: settings.${key}`).not.toHaveLength(0);
    }
  });
});
