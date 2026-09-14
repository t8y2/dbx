import * as api from "@/lib/backend/api";
import type { InstalledPlugin } from "@/types/database";

let installedPluginsPromise: Promise<InstalledPlugin[]> | null = null;

function installedPlugins(): Promise<InstalledPlugin[]> {
  installedPluginsPromise ||= api.listPlugins().catch((error) => {
    installedPluginsPromise = null;
    throw error;
  });
  return installedPluginsPromise;
}

export function clearPluginIconCache() {
  installedPluginsPromise = null;
}

export async function resolvePluginIcon(pluginId: string, contributionId?: string): Promise<string | undefined> {
  const plugin = (await installedPlugins()).find((entry) => entry.manifest.id === pluginId);
  if (!plugin) return undefined;
  const contribution = contributionId ? plugin.manifest.contributions?.find((entry) => entry.id === contributionId) : undefined;
  return (contribution && "icon" in contribution ? contribution.icon : undefined) || plugin.manifest.icon;
}
