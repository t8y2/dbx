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

type Messages = Record<string, unknown>;

const locales: Array<[string, Messages]> = [
  ["az", az],
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

const namespaces = ["quickOpen"] as const;

function leafEntries(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Messages).flatMap(([key, child]) => leafEntries(child, prefix ? `${prefix}.${key}` : key));
}

describe.each(namespaces)("%s i18n namespace parity", (namespace) => {
  const englishEntries = new Map(leafEntries((en as Messages)[namespace]));

  it("english declares the namespace", () => {
    expect(englishEntries.size).toBeGreaterThan(0);
  });

  it("english declares the global-search keys", () => {
    for (const key of ["searchingContent", "globalSearchHint", "modeObjects", "modeContent", "contentPlaceholder", "searchSettings", "searchRoots", "addDirectory", "noRootsConfigured", "removePath", "searchExtensions", "extensionsPlaceholder", "apply"]) {
      expect(englishEntries.has(key), `missing quickOpen.${key}`).toBe(true);
    }
  });

  it.each(locales)("%s declares the same keys", (_name, locale) => {
    const localeEntries = new Map(leafEntries(locale[namespace]));
    expect([...localeEntries.keys()].sort()).toEqual([...englishEntries.keys()].sort());
  });

  it("every locale declares the globalSearch shortcut label", () => {
    for (const [name, locale] of locales) {
      const settings = locale.settings as Messages | undefined;
      expect(settings?.shortcutGlobalSearch, `${name}.settings.shortcutGlobalSearch`).toBeTruthy();
    }
  });
});
