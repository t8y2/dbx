import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("EditorSettingsDialog CC-SWITCH provider", () => {
  it("gates the provider on an installed compatible plugin capability", () => {
    expect(dialogSource).toContain('<SelectItem v-if="!isWeb && aiCcSwitchPluginAvailable" :value="CC_SWITCH_PROVIDER_ID">');
    expect(dialogSource).toContain("const aiCcSwitchPluginAvailable = computed(() => isCcSwitchPluginAvailable(aiCcSwitchPlugins.value));");
    expect(dialogSource).toContain("listPlugins");
  });

  it("keeps only the host import action", () => {
    expect(dialogSource).toContain('@click="aiImportCcSwitchConfigs"');
    expect(dialogSource).not.toContain("aiInstallCcSwitchPlugin");
    expect(dialogSource).not.toContain("aiInstallCcSwitchPluginLocal");
    expect(dialogSource).not.toContain("aiUninstallCcSwitchPlugin");
    expect(dialogSource).not.toContain("installCcSwitchPlugin");
    expect(dialogSource).not.toContain("uninstallCcSwitchPlugin");
  });

  it("offers the plugin center when the capability is unavailable", () => {
    expect(dialogSource).toContain("!aiCcSwitchPluginAvailable");
    expect(dialogSource).toContain('aiCcSwitchPluginStatus.value === "incompatible" ? "ai.ccSwitchPluginIncompatible" : "ai.ccSwitchPluginNotInstalledStatus"');
    expect(dialogSource).toContain("t(aiCcSwitchPluginStatusText)");
    expect(dialogSource).toContain(`@click="emit('open-cc-switch-plugin-center')"`);
  });

  it("lists unsupported source entries as disabled with a reason and can refresh the source", () => {
    expect(dialogSource).toContain('@click="refreshAiImportSources"');
    expect(dialogSource).toContain('v-for="(skipped, index) in aiImportSkipped"');
    expect(dialogSource).toContain(":aria-label=\"t('ai.aiImportUnsupported')\"");
    expect(dialogSource).toContain("aiImportSkippedReason(skipped.reason)");
    expect(dialogSource).toContain("ccSwitchUnsupportedProviderType");
  });
});
