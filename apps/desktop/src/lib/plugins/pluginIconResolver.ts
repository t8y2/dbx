import * as api from "@/lib/backend/api";
import type { InstalledPlugin } from "@/types/database";
import { COMPONENT_PLUGINS_UPDATED_EVENT } from "@/lib/updates/componentUpdateEvents";

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

// This cache is global, but the plugin set can change from entry points other than the plugin
// center (e.g. the update center dispatches COMPONENT_PLUGINS_UPDATED_EVENT from App.vue while the
// center is closed; batch uninstall dispatches only dbx:plugins-changed). Invalidate on both
// events here, at the cache owner, so freshly installed or updated plugins don't keep a stale
// (missing) icon in the sidebar, tabs and connection tree until the plugin center happens to
// mount.
if (typeof window !== "undefined") {
  window.addEventListener(COMPONENT_PLUGINS_UPDATED_EVENT, clearPluginIconCache);
  window.addEventListener("dbx:plugins-changed", clearPluginIconCache);
}

export async function resolvePluginIcon(pluginId: string, contributionId?: string): Promise<string | undefined> {
  const plugin = (await installedPlugins()).find((entry) => entry.manifest.id === pluginId);
  if (!plugin) return undefined;
  const contribution = contributionId ? plugin.manifest.contributions?.find((entry) => entry.id === contributionId) : undefined;
  return (contribution && "icon" in contribution ? contribution.icon : undefined) || plugin.manifest.icon;
}
