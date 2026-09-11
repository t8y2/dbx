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

// Shared actions such as KafkaMessagesPanel and DoltVersionControl render
// `t("common.refresh")`. When the key is missing everywhere, vue-i18n echoes
// the key path itself (issue #8768). KafkaMessagesPanel.spec.ts mocks i18n as
// `t: (key) => key`, so that spec cannot catch a missing-from-everywhere key.
const locales: Array<[string, Record<string, unknown>]> = [
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

function commonRefresh(locale: Record<string, unknown>): unknown {
  const common = locale["common"];
  if (!common || typeof common !== "object") return undefined;
  return (common as Record<string, unknown>)["refresh"];
}

describe("common.refresh i18n key", () => {
  it("en resolves common.refresh to text", () => {
    const value = commonRefresh(en as Record<string, unknown>);
    expect(value, "common.refresh missing from locales/en.ts").toBeTypeOf("string");
    expect(value).not.toBe("");
    expect(value).not.toBe("common.refresh");
  });

  it.each(locales)("%s resolves common.refresh to text", (_name, locale) => {
    const value = commonRefresh(locale);
    expect(value, `${_name} common.refresh`).toBeTypeOf("string");
    expect(value).not.toBe("");
    expect(value).not.toBe("common.refresh");
  });

  it("zh-CN uses a Chinese refresh label", () => {
    expect(commonRefresh(zhCN)).toBe("刷新");
  });
});
