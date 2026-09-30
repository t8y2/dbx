import type { InstalledPlugin } from "@/types/database";

export const CC_SWITCH_PLUGIN_ID = "cc-switch";
export const CC_SWITCH_PLUGIN_CAPABILITY = "ai-config-import";

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
