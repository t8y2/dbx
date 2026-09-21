import { describe, expect, it } from "vitest";
import en from "../locales/en";
import es from "../locales/es";
import itLocale from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

function entries(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => entries(child, prefix ? `${prefix}.${key}` : key));
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{[^{}]+\}/g)].map(([match]) => match).sort();
}

const source = new Map(entries(zhCN.nacos).filter(([key]) => key.startsWith("contentReplace") || key.startsWith("replaceHistory.")));
const english = new Map(entries(en.nacos));
const locales = { en, es, it: itLocale, ja, ko, "pt-BR": ptBR, "zh-TW": zhTW };

describe("Nacos global replacement translations", () => {
  it("declares the new source messages", () => {
    expect(source.size).toBe(51);
  });

  it.each(Object.entries(locales))("%s has localized messages with matching placeholders", (name, locale) => {
    const translated = new Map(entries(locale.nacos));
    for (const [key, text] of source) {
      expect(translated.get(key), key).toBeTruthy();
      expect(placeholders(translated.get(key) ?? ""), key).toEqual(placeholders(text));
      if (name !== "en") expect(translated.get(key), `${name}:${key} must not fall back to English`).not.toBe(english.get(key));
    }
  });
});
