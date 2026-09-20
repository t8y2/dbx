import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const toolbarSource = readFileSync(new URL("../../../components/layout/AppToolbar.vue", import.meta.url), "utf8");
const groupTabBarSource = readFileSync(new URL("../../../components/layout/EditorGroupTabBar.vue", import.meta.url), "utf8");
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
    // The plugin center pill lives in the focused group's tab strip, like the
    // settings and driver-store special pages.
    expect(groupTabBarSource).toContain("data-plugin-center-tab");
    expect(appSource).toContain(':plugin-center-open="pluginCenterTabOpen"');
  });

  it("keeps plugin management out of Driver Manager", () => {
    expect(driverStoreSource).not.toContain('value="plugins"');
    expect(driverStoreSource).not.toContain("PluginContributionsPanel");
  });

  it("refreshes toolbar update state after manual and component update checks", () => {
    expect(appSource).toContain('if (componentRefresh.status === "fulfilled" && componentRefresh.value) syncToolbarComponentUpdateState()');
    expect(appSource).toContain("if (result.failed.length === 0) syncToolbarComponentUpdateState()");
    expect(appSource).toContain("function syncToolbarComponentUpdateState()");
  });

  it("refreshes all update sources in the background whenever the update center opens", () => {
    expect(appSource).toContain("function handleToolbarUpdateClick() {\n  showUpdateDialog.value = true;\n  if (!checkingAllUpdates.value) void checkAllUpdates();\n}");
  });

  it("refreshes the plugin center after component-level plugin updates", () => {
    expect(appSource).toContain("notifyComponentPluginsUpdated()");
    expect(pluginCenterSource).toContain("COMPONENT_PLUGINS_UPDATED_EVENT");
    expect(pluginCenterSource).toContain("window.addEventListener(COMPONENT_PLUGINS_UPDATED_EVENT, handleComponentPluginsUpdated)");
    expect(pluginCenterSource).toContain("installedPlugins.value = await api.listPlugins()");
  });

  it("formats structured backend errors for local and URL package installs", () => {
    const localInstall = pluginCenterSource.slice(pluginCenterSource.indexOf("async function installPlugin("), pluginCenterSource.indexOf("function isHttpPackageUrl("));
    const urlInstall = pluginCenterSource.slice(pluginCenterSource.indexOf("async function installPluginFromUrl("), pluginCenterSource.indexOf("const urlProgressPercent"));

    for (const installSource of [localInstall, urlInstall]) {
      expect(installSource).toContain("toast(translateBackendError(t, cause), 8000)");
      expect(installSource).not.toContain("String(cause)");
    }
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
  });
});
