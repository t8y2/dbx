import type { InstalledPlugin } from "@/types/database";

export const CC_SWITCH_PLUGIN_ID = "cc-switch";
export const CC_SWITCH_PLUGIN_CAPABILITY = "ai-config-import";

export function isCcSwitchPluginAvailable(plugins: readonly InstalledPlugin[]): boolean {
  return plugins.some((plugin) => plugin.manifest.id === CC_SWITCH_PLUGIN_ID && plugin.compatibility.compatible && plugin.manifest.capabilities?.some((capability) => capability.id === CC_SWITCH_PLUGIN_CAPABILITY));
}
