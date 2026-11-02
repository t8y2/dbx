import { describe, expect, it } from "vitest";
import * as messages from "../locales/mongodbDatabaseDump";

function leaves(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child === "string") return [[path, child]];
      return Object.entries(leaves(child as Record<string, unknown>, path));
    }),
  );
}

describe("MongoDB dump translations", () => {
  const source = leaves(messages.mongodbDatabaseDumpEn);
  for (const [locale, value] of Object.entries(messages)) {
    it(`${locale} includes every key and preserves placeholders`, () => {
      const translated = leaves(value);
      expect(Object.keys(translated).sort()).toEqual(Object.keys(source).sort());
      for (const [key, text] of Object.entries(translated)) {
        expect(text.trim(), key).not.toBe("");
        expect((text.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((source[key]!.match(/\{\w+\}/g) ?? []).sort());
      }
    });
  }
});
