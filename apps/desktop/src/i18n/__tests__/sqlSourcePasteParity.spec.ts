import { describe, expect, it } from "vitest";
import az from "../locales/az";
import en from "../locales/en";
import es from "../locales/es";
import id from "../locales/id";
import it_ from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import ru from "../locales/ru";
import tr from "../locales/tr";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

// 「粘贴源码 SQL 自动还原」相关文案需要所有语言齐全，避免回落到英文
const SETTINGS_KEYS = ["restoreSqlFromSourcePaste", "restoreSqlFromSourcePasteDescription"] as const;
const EDITOR_KEYS = ["sqlSourcePasteRestored", "sqlSourcePasteNotDetected"] as const;
const CONTEXT_MENU_KEYS = ["pasteRestoringSourceSql"] as const;

const locales: Array<[string, Record<string, unknown>]> = [
  ["en", en as Record<string, unknown>],
  ["az", az as Record<string, unknown>],
  ["es", es],
  ["id", id],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["ru", ru],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

function nested(locale: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  let scope: unknown = locale;
  for (const segment of path) {
    if (!scope || typeof scope !== "object") return undefined;
    scope = (scope as Record<string, unknown>)[segment];
  }
  return scope && typeof scope === "object" ? (scope as Record<string, unknown>) : undefined;
}

function settingsText(locale: Record<string, unknown>, key: string): unknown {
  return nested(locale, ["settings"])?.[key];
}

function editorText(locale: Record<string, unknown>, key: string): unknown {
  return nested(locale, ["editor"])?.[key];
}

function contextMenuText(locale: Record<string, unknown>, key: string): unknown {
  return nested(locale, ["editor", "contextMenu"])?.[key];
}

const english = en as Record<string, unknown>;

describe("source-code SQL paste i18n messages", () => {
  it.each(SETTINGS_KEYS)("en resolves settings.%s to text", (key) => {
    expect(settingsText(english, key), `settings.${key} missing from locales/en.ts`).toBeTypeOf("string");
  });

  it.each(EDITOR_KEYS)("en resolves editor.%s to text", (key) => {
    expect(editorText(english, key), `editor.${key} missing from locales/en.ts`).toBeTypeOf("string");
  });

  it.each(CONTEXT_MENU_KEYS)("en resolves editor.contextMenu.%s to text", (key) => {
    expect(contextMenuText(english, key), `editor.contextMenu.${key} missing from locales/en.ts`).toBeTypeOf("string");
  });

  it.each(locales.slice(1))("%s translates the source-code SQL paste labels instead of using the English fallback", (_name, locale) => {
    for (const key of SETTINGS_KEYS) {
      expect(settingsText(locale, key), `${_name} settings.${key}`).toBeTypeOf("string");
      expect(settingsText(locale, key), `${_name} settings.${key} should not reuse the English text`).not.toBe(settingsText(english, key));
    }
    for (const key of EDITOR_KEYS) {
      expect(editorText(locale, key), `${_name} editor.${key}`).toBeTypeOf("string");
      expect(editorText(locale, key), `${_name} editor.${key} should not reuse the English text`).not.toBe(editorText(english, key));
    }
    for (const key of CONTEXT_MENU_KEYS) {
      expect(contextMenuText(locale, key), `${_name} editor.contextMenu.${key}`).toBeTypeOf("string");
      expect(contextMenuText(locale, key), `${_name} editor.contextMenu.${key} should not reuse the English text`).not.toBe(contextMenuText(english, key));
    }
  });
});
