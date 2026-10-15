import type { InstalledPlugin } from "@/types/database";
import { compareVersions } from "@/lib/plugins/pluginMarketplace";

export const CC_SWITCH_PLUGIN_ID = "cc-switch";
export const CC_SWITCH_PLUGIN_CAPABILITY = "ai-config-import";
export const MAGPIE_IMPORT_MINIMUM_PLUGIN_VERSION = "0.2.2";

export type CcSwitchPluginStatus = "available" | "incompatible" | "not-installed";

export function getCcSwitchPluginStatus(plugins: readonly InstalledPlugin[]): CcSwitchPluginStatus {
  const plugin = plugins.find((item) => item.manifest.id === CC_SWITCH_PLUGIN_ID);
  if (!plugin) return "not-installed";
  if (!plugin.compatibility.compatible || !plugin.manifest.capabilities?.some((capability) => capability.id === CC_SWITCH_PLUGIN_CAPABILITY)) {
    return "incompatible";
  }
  return "available";
}

export function isCcSwitchPluginAvailable(plugins: readonly InstalledPlugin[]): boolean {
  return getCcSwitchPluginStatus(plugins) === "available";
}

export function isMagpieImportAvailable(plugins: readonly InstalledPlugin[]): boolean {
  const plugin = plugins.find((item) => item.manifest.id === CC_SWITCH_PLUGIN_ID);
  if (!plugin || getCcSwitchPluginStatus(plugins) !== "available") return false;
  return compareVersions(plugin.manifest.version || "0.0.0", MAGPIE_IMPORT_MINIMUM_PLUGIN_VERSION) >= 0;
}
