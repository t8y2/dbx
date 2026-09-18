import type { FrontendPluginDefinition } from "@/lib/plugins/frontendPlugin";

const PINNED_PLUGINS_STORAGE_KEY = "dbx-plugin-pinned-ids";

export function loadPinnedPluginIds(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const saved = localStorage.getItem(PINNED_PLUGINS_STORAGE_KEY);
    const ids = saved ? JSON.parse(saved) : [];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function savePinnedPluginIds(ids: string[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PINNED_PLUGINS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage may be unavailable (private mode); pinning just won't persist.
  }
}

/** Stable partition: pinned plugins keep their relative order first, then
 *  the rest follow in their original order. Unknown ids in the pinned list
 *  are ignored so uninstalling a plugin leaves no phantom pins. */
export function sortPluginsPinnedFirst<T extends FrontendPluginDefinition>(definitions: T[], pinnedIds: string[]): T[] {
  const pinned = new Set(pinnedIds);
  const pinnedPart = definitions.filter((definition) => pinned.has(definition.plugin.manifest.id));
  if (pinnedPart.length === 0) return definitions;
  return [...pinnedPart, ...definitions.filter((definition) => !pinned.has(definition.plugin.manifest.id))];
}
