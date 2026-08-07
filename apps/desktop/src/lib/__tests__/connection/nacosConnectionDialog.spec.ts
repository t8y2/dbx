import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("Nacos connection dialog layout", () => {
  it("presents implementation and version as one explicit connection profile", () => {
    expect(source).toContain("data-nacos-profile-selector");
    expect(source).toContain('v-for="profile in NACOS_CONNECTION_PROFILES"');
    expect(source).toContain("selectNacosConnectionProfile(profile.value)");
    expect(source).not.toContain("nacosVersionMode = 'auto'");
    expect(source).not.toContain("tryNacosDockerConsoleFallback");
    expect(source).not.toContain("dockerNacosConsoleFallbackUrl");
  });

  it("keeps the primary form focused on endpoints and authentication", () => {
    const mainStart = source.indexOf("data-nacos-profile-selector");
    const mainEnd = source.indexOf("<!-- Redis: host, port, user, password, ssl -->", mainStart);
    const main = source.slice(mainStart, mainEnd);

    expect(main).toContain("data-nacos-endpoint-section");
    expect(main).toContain("data-nacos-access-section");
    expect(main).toContain("data-nacos-advanced-hint");
    expect(main).toContain('t("nacos.nacosAdvancedHint")');
    expect(main).toContain("@click=\"configTab = 'advanced'\"");
    expect(main).toContain('v-model="nacosServerAddr"');
    expect(main).not.toContain('v-model="nacosV3ConsoleAddr"');
    expect(main).not.toContain('v-model="nacosNamespace"');
    expect(main).toContain('t("nacos.nacosAuthHint")');
    expect(main).not.toContain('v-model="nacosMetricsMode"');
    expect(main).not.toContain('v-model.number="nacosPageSize"');
  });

  it("moves low-frequency and r-nacos console settings to the advanced tab", () => {
    const advancedStart = source.indexOf("data-nacos-advanced-settings");
    const advancedEnd = source.indexOf('v-if="showGaussdbConnectionMode"', advancedStart);
    const advanced = source.slice(advancedStart, advancedEnd);

    expect(advanced).not.toContain('v-model="nacosContextPathInput"');
    expect(advanced).not.toContain("配置上下文路径");
    expect(advanced).toContain('v-model="nacosMetricsMode"');
    expect(advanced).toContain('v-model="nacosRNacosConsoleAddr"');
    expect(advanced).toContain('v-if="nacosHistoryEnabled"');
    expect(advanced).toContain('t("nacos.nacosRnacosDisabledHint")');
    expect(advanced).toContain('v-model="nacosTlsSkipVerify"');
    expect(advanced).toContain('v-model.number="nacosPageSize"');
  });

  it("documents product default ports instead of local Docker mappings", () => {
    expect(source).toContain('t("nacos.nacosServiceAddressHint")');
    expect(source).toContain('t("nacos.nacosMetricsHint")');
    expect(source).not.toContain("DBX 不需要配置该地址");
    const mainStart = source.indexOf("data-nacos-profile-selector");
    const mainEnd = source.indexOf("<!-- Redis: host, port, user, password, ssl -->", mainStart);
    expect(source.slice(mainStart, mainEnd)).not.toContain('placeholder="http://127.0.0.1:8080"');
    expect(source).not.toContain("http://127.0.0.1:8010");
    expect(source).not.toContain("http://127.0.0.1:8818");
  });

  it("uses a dedicated namespace selector instead of the database selector", () => {
    expect(source).toContain('t("nacos.nacosVisibleNamespacesTitle")');
    expect(source).toContain("openVisibleNacosNamespacesPicker");
    expect(source).toContain("api.nacosListNamespaces(draftId)");
    expect(source).toContain("showVisibleNacosNamespacesDialog");
  });
});
