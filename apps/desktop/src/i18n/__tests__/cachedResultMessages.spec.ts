import { readFileSync } from "node:fs";
import { describe, expect, it as test } from "vitest";
import en from "@/i18n/locales/en";
import es from "@/i18n/locales/es";
import it from "@/i18n/locales/it";
import ja from "@/i18n/locales/ja";
import ptBR from "@/i18n/locales/pt-BR";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";

const contentAreaSource = readFileSync(new URL("../../components/layout/ContentArea.vue", import.meta.url), "utf8");

function cachedResultMessages(messages: Record<string, unknown>): Record<string, unknown> {
  return messages.grid as Record<string, unknown>;
}

describe("cached result messages", () => {
  test.each([
    ["English", en],
    ["Spanish", es],
    ["Italian", it],
    ["Japanese", ja],
    ["Brazilian Portuguese", ptBR],
    ["Simplified Chinese", zhCN],
    ["Traditional Chinese", zhTW],
  ])("provides the missing-result actions in %s", (_locale, messages) => {
    const grid = cachedResultMessages(messages);

    expect(grid.cachedResultUnavailable).toEqual(expect.any(String));
    expect(grid.reexecuteQuery).toEqual(expect.any(String));
  });

  test("uses the grid namespace from the cached-result fallback UI", () => {
    expect(contentAreaSource).toContain('t("grid.cachedResultUnavailable")');
    expect(contentAreaSource).toContain('t("grid.reexecuteQuery")');
    expect(contentAreaSource).not.toContain('t("editor.cachedResultUnavailable")');
    expect(contentAreaSource).not.toContain('t("editor.reexecuteQuery")');
  });
});
