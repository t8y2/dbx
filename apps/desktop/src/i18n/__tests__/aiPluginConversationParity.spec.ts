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

// Keys the plugin AI conversation adds to the `ai` namespace. The panel renders
// in whatever locale the user runs, so a missing key would leak a raw key into
// the composer placeholder or the welcome copy.
const AI_PLUGIN_CONVERSATION_KEYS = ["pluginHttpModelOnly", "pluginWelcome", "pluginFollowUp"] as const;

describe("plugin AI conversation locale parity", () => {
  it.each(locales)("%s exposes the plugin conversation copy", (_name, locale) => {
    const ai = (locale as { ai: Record<string, unknown> }).ai;
    for (const key of AI_PLUGIN_CONVERSATION_KEYS) {
      expect(ai[key], `${_name}: ai.${key}`).toBeTypeOf("string");
      expect(ai[key] as string, `${_name}: ai.${key}`).not.toHaveLength(0);
    }
  });
});
