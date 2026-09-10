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

const locales: Array<[string, Record<string, unknown>]> = [
  ["az", az],
  ["en", en],
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

// Keys the safe-HTML preview (PR2 of #6467) adds to the `ai` namespace. Every
// locale must expose all of them — the preview UI renders in whatever locale
// the user runs, and a missing key would leak raw keys into the toolbar.
const AI_HTML_PREVIEW_KEYS = ["htmlPreviewLabel", "htmlExpandPreview", "htmlExpandPreviewHint", "htmlSaveSafe", "htmlSaveFailed", "htmlCopySource", "htmlCopyRiskBody", "htmlCopyRiskAccept", "htmlCopyRiskRemember", "htmlCopyRiskToast"] as const;

// Keys the conversation export (PR3 of #6467) adds to the `ai` namespace —
// header menu entry, report role labels, failure marker, and empty-state copy.
const AI_CONVERSATION_EXPORT_KEYS = ["exportConversation", "conversationExportMarkdown", "conversationExportHtml", "conversationRoleUser", "conversationRoleAssistant", "conversationFailedMarker", "conversationExportEmpty"] as const;

describe("AI rich content locale parity", () => {
  it.each(locales)("%s exposes the full ai.html* key set with non-empty copy", (_name, locale) => {
    const ai = (locale as { ai: Record<string, unknown> }).ai;
    for (const key of AI_HTML_PREVIEW_KEYS) {
      expect(ai[key], `${_name}: ai.${key}`).toBeTypeOf("string");
      expect(ai[key] as string, `${_name}: ai.${key}`).not.toHaveLength(0);
    }
  });

  it.each(locales)("%s exposes the full conversation-export key set with non-empty copy", (_name, locale) => {
    const ai = (locale as { ai: Record<string, unknown> }).ai;
    for (const key of AI_CONVERSATION_EXPORT_KEYS) {
      expect(ai[key], `${_name}: ai.${key}`).toBeTypeOf("string");
      expect(ai[key] as string, `${_name}: ai.${key}`).not.toHaveLength(0);
    }
  });
});
