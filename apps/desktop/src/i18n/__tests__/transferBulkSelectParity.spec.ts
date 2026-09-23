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

// 数据传输「批量录入对象」相关文案，需要所有语言齐全，避免回落到英文
const TRANSFER_BULK_SELECT_KEYS = ["bulkSelectObjects", "bulkSelectTitle", "bulkSelectHint", "bulkSelectPlaceholder", "bulkSelectConfirm", "bulkSelectMatched", "bulkSelectUnmatched", "noMatchingObjects"] as const;

const locales: Array<[string, Record<string, unknown>]> = [
  ["en", en as Record<string, unknown>],
  ["az", az as Record<string, unknown>],
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

function transferEntry(locale: Record<string, unknown>, key: string): unknown {
  const transfer = locale["transfer"];
  if (!transfer || typeof transfer !== "object") return undefined;
  return (transfer as Record<string, unknown>)[key];
}

describe("transfer bulk-select i18n messages", () => {
  it.each(TRANSFER_BULK_SELECT_KEYS)("en resolves transfer.%s to text", (key) => {
    expect(transferEntry(en as Record<string, unknown>, key), `transfer.${key} missing from locales/en.ts`).toBeTypeOf("string");
  });

  it.each(locales.slice(1))("%s translates the bulk-select labels instead of using the English fallback", (_name, locale) => {
    for (const key of TRANSFER_BULK_SELECT_KEYS) {
      const value = transferEntry(locale, key);
      expect(value, `${_name} transfer.${key}`).toBeTypeOf("string");
      expect(value, `${_name} transfer.${key} should not reuse the English text`).not.toBe(transferEntry(en as Record<string, unknown>, key));
    }
  });
});
