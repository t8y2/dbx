import { describe, expect, it } from "vitest";
import * as messages from "../locales/binlogRecovery";

const placeholders = (text: string) => text.match(/\{[^{}]+\}/g)?.sort() ?? [];

describe("binlog recovery translations", () => {
  for (const locale of ["En", "ZhCN", "ZhTW", "Es", "It", "Ja", "Ko", "PtBR", "Ru", "Th"]) {
    it(`${locale} explicitly translates every key and preserves placeholders`, () => {
      const translated = (messages as unknown as Record<string, Record<string, string>>)[`binlogRecovery${locale}`];
      expect(translated).toBeDefined();
      expect(Object.keys(translated).sort()).toEqual(Object.keys(messages.binlogRecoveryEn).sort());
      for (const [key, source] of Object.entries(messages.binlogRecoveryEn)) {
        expect(translated[key].trim(), key).not.toBe("");
        expect(placeholders(translated[key]), key).toEqual(placeholders(source));
      }
    });
  }
});
