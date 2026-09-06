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

// EditorGroupTabBar renders its context menu via `t("contextMenu.<key>")`.
// When a key is missing everywhere, vue-i18n echoes the key path itself and
// the menu shows raw text like "contextMenu.pinTab" (regression in 5a3a6e2bb:
// the component landed without locale entries; spec mocks supplied their own
// translations, so tests stayed green). en is the fallbackLocale, so a missing
// en key leaks the raw path in every language — guard the full tab-menu key
// set against the real en module, not a mock.
const tabMenuKeys = ["changeOrientation", "closeAllTabs", "closeLeftTabs", "closeOtherTabs", "closeRightTabs", "closeTab", "closeTabGroup", "compactTabTitle", "copyName", "editTabGroup", "fullTabTitle", "pinTab", "resetTabGroup", "splitDown", "splitRight", "unpinTab", "unsplit"] as const;

// Non-English locales are `export default withEnglishFallback({...})`, so
// these imports are en-merged; the assertions below prove the key resolves to
// real text for every UI language, while the en test above is the one that
// actually catches a missing-from-everywhere key.
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

function contextMenuEntry(locale: Record<string, unknown>, key: string): unknown {
  const contextMenu = locale["contextMenu"];
  if (!contextMenu || typeof contextMenu !== "object") return undefined;
  return (contextMenu as Record<string, unknown>)[key];
}

describe("tab context menu i18n keys", () => {
  it.each(tabMenuKeys)("en resolves contextMenu.%s to text", (key) => {
    const value = contextMenuEntry(en as Record<string, unknown>, key);
    expect(value, `contextMenu.${key} missing from locales/en.ts`).toBeTypeOf("string");
    expect(value).not.toBe("");
  });

  it.each(locales)("%s resolves pin/unpin tab menu labels", (_name, locale) => {
    for (const key of ["pinTab", "unpinTab"] as const) {
      expect(contextMenuEntry(locale, key), `${_name} contextMenu.${key}`).toBeTypeOf("string");
    }
  });
});
