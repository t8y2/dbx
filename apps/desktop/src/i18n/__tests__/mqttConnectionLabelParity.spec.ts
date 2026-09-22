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

// These assertions read the locale SOURCES as text instead of importing the modules.
// Every non-English locale is `export default withEnglishFallback({ ... })`, and
// withEnglishFallback deep-merges `en` UNDER the locale at import time, so the imported
// default export already carries every english key — including the key this spec exists
// to guard. Asserting on those objects would pass even if a locale silently dropped the
// label (same trap documented in docsNamespaceParity.spec.ts), so the check has to happen
// before the merge does.
function localeSource(name: string): string {
  return readFileSync(new URL(`../locales/${name}.ts`, import.meta.url), "utf8");
}

function declaredString(source: string, key: string): string | undefined {
  return source.match(new RegExp(String.raw`^\s*${key}:\s*"((?:[^"\\]|\\.)*)",\s*$`, "m"))?.[1];
}

// The locales that carry the connection.mqtt* form cluster (led by mqttKeepAlive).
const localesCarryingMqttCluster = ["en", "zh-CN", "zh-TW", "ja", "it", "es", "pt-BR", "tr", "az"];
// Every locale FILE must declare the key in source. This is the assertion that actually
// guards drift: the imported modules cannot show a removed source key, because
// withEnglishFallback deep-merges english underneath at import time (see header).
const allLocaleFiles = [...localesCarryingMqttCluster, "ko"];

describe("mqtt max packet size label i18n parity", () => {
  it("english declares the label with its byte unit", () => {
    expect(declaredString(localeSource("en"), "mqttMaxPacketSize")).toContain("bytes");
  });

  it.each(allLocaleFiles)("%s declares the label in its source file", (name) => {
    const label = declaredString(localeSource(name), "mqttMaxPacketSize");
    expect(label, `${name}.ts must declare connection.mqttMaxPacketSize`).toBeTruthy();
    expect(label?.trim()).not.toBe("");
  });

  it.each(localesCarryingMqttCluster)("%s declares the label alongside its mqtt cluster", (name) => {
    const source = localeSource(name);
    // Anchor: only locales that already declare the cluster get the new key.
    expect(declaredString(source, "mqttKeepAlive"), `${name}.ts must declare connection.mqttKeepAlive`).toBeTruthy();
    // Semantic-cluster anchoring (i18n-locales.md): the label belongs next to mqttConnectTimeout.
    expect(source.indexOf("mqttMaxPacketSize:"), `${name}.ts must anchor the key after mqttConnectTimeout`).toBeGreaterThan(source.indexOf("mqttConnectTimeout:"));
  });

  it("ko declares the label without taking on the rest of the mqtt form cluster", () => {
    const source = localeSource("ko");
    // ko translates a few mqtt console strings but none of the form fields, so the form
    // renders in english there via withEnglishFallback. This one label is the deliberate
    // exception: it is declared in source so the Korean text exists in the file, and it is
    // the only form key ko owns — do not grow the cluster here.
    expect(declaredString(source, "mqttMaxPacketSize")).toBeTruthy();
    expect(declaredString(source, "mqttKeepAlive")).toBeUndefined();
    expect(declaredString(source, "mqttConnectTimeout")).toBeUndefined();
  });
});

// Layer (a) from the PRD: the label must also resolve through vue-i18n at runtime. This is
// weaker than the source-level check above — the deep-merge hands a locale that drops the
// key the english text, so it cannot see drift — but it is what catches a locale module
// that fails to declare or parse the key at all, and the "key path leaks into the UI"
// failure mode that a missing translation produces.
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

describe("mqtt max packet size label resolution", () => {
  it.each(localeModules)("%s resolves the label to a translated string", (name, messages) => {
    const connection = (messages.connection ?? {}) as typeof en.connection;
    const i18n = createI18n({ legacy: false, locale: name, messages: { [name]: { connection } } });
    const label = i18n.global.t("connection.mqttMaxPacketSize");
    expect(label).not.toBe("connection.mqttMaxPacketSize");
    expect(label.trim()).not.toBe("");
    i18n.dispose();
  });
});

describe("connection dialog mqtt label call site", () => {
  const componentSource = readFileSync(new URL("../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

  it("renders the label through vue-i18n instead of a hardcoded chinese string", () => {
    expect(componentSource).toContain('{{ t("connection.mqttMaxPacketSize") }}');
    expect(componentSource).not.toContain("最大报文");
  });
});
