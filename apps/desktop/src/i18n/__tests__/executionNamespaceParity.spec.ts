import { describe, expect, it } from "vitest";
import en from "../locales/en";
import es from "../locales/es";
import it_ from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

type Messages = Record<string, unknown>;

const locales: Array<[string, Messages]> = [
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

const namespaces = ["multiDbExecute", "exportProgress"] as const;

function leafEntries(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Messages).flatMap(([key, child]) => leafEntries(child, prefix ? `${prefix}.${key}` : key));
}

function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]))].sort();
}

describe.each(namespaces)("%s i18n namespace parity", (namespace) => {
  const englishEntries = new Map(leafEntries((en as Messages)[namespace]));

  it("english declares the namespace", () => {
    expect(englishEntries.size).toBeGreaterThan(0);
  });

  it.each(locales)("%s declares the same keys and placeholders", (_name, locale) => {
    const localeEntries = new Map(leafEntries(locale[namespace]));
    expect([...localeEntries.keys()].sort()).toEqual([...englishEntries.keys()].sort());

    for (const [key, englishMessage] of englishEntries) {
      expect(placeholders(localeEntries.get(key) ?? ""), `${namespace}.${key}`).toEqual(placeholders(englishMessage));
    }
  });
});
