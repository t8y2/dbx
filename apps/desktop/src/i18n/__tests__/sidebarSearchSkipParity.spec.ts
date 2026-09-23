import { readFileSync } from "node:fs";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import az from "@/i18n/locales/az";
import en from "@/i18n/locales/en";
import es from "@/i18n/locales/es";
import itLocale from "@/i18n/locales/it";
import ja from "@/i18n/locales/ja";
import ko from "@/i18n/locales/ko";
import ptBR from "@/i18n/locales/pt-BR";
import tr from "@/i18n/locales/tr";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";

// The sidebar-search skip hint is a single-line projection of a driver error
// (see connectionStore.recordSidebarSearchConnectionFailure). Every locale has
// to own the `{message}` placeholder, so this reads the locale SOURCES as text:
// non-English locales are `export default withEnglishFallback({ ... })`, and the
// import-time deep merge would hide a locale that silently dropped the key.
function localeSource(name: string): string {
  return readFileSync(new URL(`../locales/${name}.ts`, import.meta.url), "utf8");
}

function declaredString(source: string, key: string): string | undefined {
  return source.match(new RegExp(String.raw`^\s*${key}:\s*"((?:[^"\\]|\\.)*)",\s*$`, "m"))?.[1];
}

const localeNames = ["az", "en", "es", "it", "ja", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];

describe("sidebar search skip hint i18n parity", () => {
  it("english declares the key with its message placeholder", () => {
    const label = declaredString(localeSource("en"), "searchConnectionSkipped");
    expect(label).toContain("{message}");
  });

  it.each(localeNames)("%s declares the key with the message placeholder in its source file", (name) => {
    const label = declaredString(localeSource(name), "searchConnectionSkipped");
    expect(label, `${name}.ts must declare sidebar.searchConnectionSkipped`).toBeTruthy();
    expect(label).toContain("{message}");
  });

  it.each(localeNames)("%s anchors the key inside the sidebar namespace", (name) => {
    const source = localeSource(name);
    expect(source.indexOf("searchConnectionSkipped:")).toBeGreaterThan(source.indexOf("sortConnectionsDescending:"));
    expect(source.indexOf("searchConnectionSkipped:")).toBeLessThan(source.indexOf("searchScopeConnection:"));
  });
});

const localeModules: Array<[string, Record<string, unknown>]> = [
  ["az", az],
  ["en", en],
  ["es", es],
  ["it", itLocale],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

describe("sidebar search skip hint resolution", () => {
  it.each(localeModules)("%s renders the driver detail inside the hint", (name, messages) => {
    const sidebar = (messages.sidebar ?? {}) as typeof en.sidebar;
    const i18n = createI18n({ legacy: false, locale: name, messages: { [name]: { sidebar } } });
    const hint = i18n.global.t("sidebar.searchConnectionSkipped", { message: "tls handshake eof" });
    expect(hint).not.toBe("sidebar.searchConnectionSkipped");
    expect(hint).toContain("tls handshake eof");
    i18n.dispose();
  });
});
