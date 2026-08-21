import { describe, expect, it } from "vitest";
import en from "../locales/en";
import es from "../locales/es";
import itLocale from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

type Messages = Record<string, unknown>;

const locales: Array<[string, Messages]> = [
  ["es", es],
  ["it", itLocale],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

function offlineExportEntries(locale: Messages): Map<string, string> {
  const driverStore = locale.driverStore as Record<string, unknown>;
  return new Map(
    Object.entries(driverStore)
      .filter(([key, value]) => key.startsWith("offlineExport") && typeof value === "string")
      .map(([key, value]) => [key, value as string]),
  );
}

function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]))].sort();
}

describe("offline Agent export i18n parity", () => {
  const englishEntries = offlineExportEntries(en);

  it("declares the complete English message set", () => {
    expect(englishEntries.size).toBe(29);
  });

  it.each(locales)("%s declares matching keys and placeholders", (_name, locale) => {
    const localeEntries = offlineExportEntries(locale);
    expect([...localeEntries.keys()].sort()).toEqual([...englishEntries.keys()].sort());

    for (const [key, englishMessage] of englishEntries) {
      expect(placeholders(localeEntries.get(key) ?? ""), key).toEqual(placeholders(englishMessage));
    }
  });
});
