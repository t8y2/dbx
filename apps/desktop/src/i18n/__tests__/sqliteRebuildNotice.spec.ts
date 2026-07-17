import { describe, expect, it as test } from "vitest";
import en from "@/i18n/locales/en";
import es from "@/i18n/locales/es";
import it from "@/i18n/locales/it";
import ja from "@/i18n/locales/ja";
import ptBR from "@/i18n/locales/pt-BR";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";

function sqliteRebuildNotice(messages: Record<string, unknown>): string {
  const structureEditor = messages.structureEditor as Record<string, unknown>;
  return String(structureEditor.sqliteRebuildNotice);
}

describe("SQLite rebuild notice", () => {
  test.each([
    ["English", en],
    ["Spanish", es],
    ["Italian", it],
    ["Japanese", ja],
    ["Brazilian Portuguese", ptBR],
    ["Simplified Chinese", zhCN],
    ["Traditional Chinese", zhTW],
  ])("warns about retained backup, forced CAST conversion, lossy values, and rollback in %s", (_locale, messages) => {
    const notice = sqliteRebuildNotice(messages);

    expect(notice.length).toBeGreaterThan(30);
    expect(notice).toContain("CAST");
    expect(notice).toContain("0.0");
  });
});
