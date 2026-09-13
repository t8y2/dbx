import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const toolbarSource = readFileSync(new URL("../../../components/layout/AppToolbar.vue", import.meta.url), "utf8");
const tabBarSource = readFileSync(new URL("../../../components/layout/AppTabBar.vue", import.meta.url), "utf8");
const driverStoreSource = readFileSync(new URL("../../../components/config/DriverStoreDialog.vue", import.meta.url), "utf8");
const appDialogsSource = readFileSync(new URL("../../../components/layout/AppDialogs.vue", import.meta.url), "utf8");
const connectionDialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const pluginCenterSource = readFileSync(new URL("../../../components/plugins/PluginContributionsPanel.vue", import.meta.url), "utf8");

describe("plugin center integration", () => {
  it("opens from the top toolbar as an independent app surface", () => {
    expect(toolbarSource).toContain("toolbarItems.pluginCenter");
    expect(toolbarSource).toContain("emit('open-plugin-center')");
    expect(appSource).toContain('@open-plugin-center="openPluginCenterPage()"');
    expect(appSource).toContain("<PluginCenterPage");
    expect(tabBarSource).toContain("data-plugin-center-tab");
  });

  it("keeps plugin management out of Driver Manager", () => {
    expect(driverStoreSource).not.toContain('value="plugins"');
    expect(driverStoreSource).not.toContain("PluginContributionsPanel");
  });

  it("creates and edits plugin connections in the unified connection dialog", () => {
    expect(appDialogsSource).toContain(':edit-config="editConfig"');
    expect(appDialogsSource).toContain(':plugin-provider="connectionPluginProvider"');
    expect(appDialogsSource).not.toContain("pluginEditConfig");
    expect(connectionDialogSource).toContain("pluginConnectionProviderOptionValue");
    expect(connectionDialogSource).toContain("<PluginConnectionFields");
    expect(connectionDialogSource).toContain("buildPluginConnectionConfig");
  });

  it("keeps marketplace security automatic and developer controls hidden", () => {
    const template = pluginCenterSource.split("<template>")[1];
    const settingsIndex = template.indexOf('value="settings"');
    const developerOptionsIndex = template.indexOf("pluginPlatform.developerOptionsTitle");
    const allowUnsignedIndex = template.indexOf("pluginPlatform.allowUnsignedDevelopmentPackage");
    expect(template).toContain('value="marketplace"');
    expect(template).toContain('value="installed"');
    expect(template).toContain('value="settings"');
    expect(settingsIndex).toBeLessThan(developerOptionsIndex);
    expect(developerOptionsIndex).toBeLessThan(allowUnsignedIndex);
    expect(template).toContain("pluginPlatform.signedPackagesVerifiedAutomatically");
    expect(template).toContain('<template v-if="showCustomRepositoryTrustSettings">');
    expect(pluginCenterSource).toContain("customRepositories.value.length > 0 || trustedKeys.value.length > 0");
    expect(template).not.toContain("pluginPlatform.advancedSecurityTitle");
    expect(pluginCenterSource).toContain("fetchPluginMarketplaceCatalogs");
    expect(template).not.toContain("pluginPlatform.centerTitle");
    expect(template).not.toContain("marketplaceTarget");
    expect(template).not.toContain("<select");
    expect(template).toContain("<SelectTrigger");
    expect(template).not.toContain("max-w-md grid-cols-3");
    expect(template).not.toContain("marketplaceCategory");
    expect(template).toContain("repeat(auto-fit");
  });
});
