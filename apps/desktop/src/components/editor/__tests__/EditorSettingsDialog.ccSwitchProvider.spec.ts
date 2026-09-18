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
    expect(dialogSource).toContain(`@click="emit('open-cc-switch-plugin-center')"`);
  });
});
