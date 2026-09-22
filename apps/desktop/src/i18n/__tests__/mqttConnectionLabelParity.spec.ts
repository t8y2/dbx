import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

describe("connection dialog mqtt label call site", () => {
  const componentSource = readFileSync(new URL("../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

  it("renders the label through vue-i18n instead of a hardcoded chinese string", () => {
    expect(componentSource).toContain('{{ t("connection.mqttMaxPacketSize") }}');
    expect(componentSource).not.toContain("最大报文");
  });
});
