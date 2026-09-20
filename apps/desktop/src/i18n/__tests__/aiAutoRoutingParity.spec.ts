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

// Keys the "Auto" picker entry (#9118) adds to the `ai` namespace: the menu
// entry, the slow-path status line, and the per-message routing chip. The picker
// and the chip render in whatever locale the user runs, so a missing key would
// leak a raw key into the toolbar.
const AI_AUTO_ROUTING_ACTIONS_KEYS = ["auto"] as const;
const AI_AUTO_ROUTING_KEYS = ["recognizing", "chip", "switchTo"] as const;
// Settings > AI toggle: new conversations start on the `auto` entry.
const AI_AUTO_ROUTING_SETTINGS_KEYS = ["defaultAutoRouting", "defaultAutoRoutingDescription"] as const;

describe("AI auto-routing locale parity", () => {
  it.each(locales)("%s exposes ai.actions.auto with non-empty copy", (_name, locale) => {
    const ai = (locale as { ai: { actions: Record<string, unknown> } }).ai;
    for (const key of AI_AUTO_ROUTING_ACTIONS_KEYS) {
      expect(ai.actions[key], `${_name}: ai.actions.${key}`).toBeTypeOf("string");
      expect(ai.actions[key] as string, `${_name}: ai.actions.${key}`).not.toHaveLength(0);
    }
  });

  it.each(locales)("%s exposes the full ai.routing.* key set with non-empty copy", (_name, locale) => {
    const routing = (locale as { ai: { routing: Record<string, unknown> } }).ai.routing;
    for (const key of AI_AUTO_ROUTING_KEYS) {
      expect(routing?.[key], `${_name}: ai.routing.${key}`).toBeTypeOf("string");
      expect(routing?.[key] as string, `${_name}: ai.routing.${key}`).not.toHaveLength(0);
    }
    // The chip interpolates the resolved action label.
    expect(routing.chip as string, `${_name}: ai.routing.chip`).toContain("{action}");
    expect(routing.switchTo as string, `${_name}: ai.routing.switchTo`).toContain("{action}");
  });

  it.each(locales)("%s exposes the default auto-routing setting keys with non-empty copy", (_name, locale) => {
    const ai = (locale as { ai: Record<string, unknown> }).ai;
    for (const key of AI_AUTO_ROUTING_SETTINGS_KEYS) {
      expect(ai[key], `${_name}: ai.${key}`).toBeTypeOf("string");
      expect(ai[key] as string, `${_name}: ai.${key}`).not.toHaveLength(0);
    }
  });
});
