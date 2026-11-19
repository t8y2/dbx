// #193 — plugin connection surfaces live on more than one host registry.
// Workbench tabs are tracked in the query store, but bottom-dock terminal
// entries (VS Code-style terminal panel) live in pluginBottomDock and floating
// windows would live in Tauri's window registry. The tab-close auto-release in
// queryStore used to count tabs only, so closing the last tab while a dock
// terminal still held the connection tore the connection down under it and
// force-reconnected every surviving dock terminal.
import type { PluginDockEntry } from "./pluginBottomDock";

/** Structural subset of a query tab the connection-surface scan needs. */
export interface PluginConnectionSurfaceTab {
  mode: string;
  title: string;
  connectionId?: string;
  pluginWorkbench?: { context?: Record<string, unknown> } | null;
}

/** Dock entry / tab shapes accepted here — picks keep the caller's real types compatible. */
export type PluginConnectionSurfaceDockEntry = Pick<PluginDockEntry, "title" | "context">;

const PLUGIN_SURFACE_TAB_MODES = new Set(["plugin-workbench", "plugin-filesystem"]);

/** Mirrors queryStore's pluginTabConnectionId: top-level connectionId wins, then the workbench context. */
export function tabReferencesPluginConnection(tab: PluginConnectionSurfaceTab, connectionId: string): boolean {
  if (tab.connectionId) return tab.connectionId === connectionId;
  const contextConnectionId = tab.pluginWorkbench?.context?.connectionId;
  return typeof contextConnectionId === "string" && contextConnectionId === connectionId;
}

export function dockEntryReferencesPluginConnection(entry: PluginConnectionSurfaceDockEntry, connectionId: string): boolean {
  const referenced = entry.context.connectionId;
  return typeof referenced === "string" && referenced === connectionId;
}

/** True while any surface (tab or dock entry) still references the connection — release must wait. */
export function anySurfaceReferencesPluginConnection(tabs: ReadonlyArray<PluginConnectionSurfaceTab>, dockEntries: ReadonlyArray<PluginConnectionSurfaceDockEntry>, connectionId: string): boolean {
  if (tabs.some((tab) => PLUGIN_SURFACE_TAB_MODES.has(tab.mode) && tabReferencesPluginConnection(tab, connectionId))) return true;
  return dockEntries.some((entry) => dockEntryReferencesPluginConnection(entry, connectionId));
}

/**
 * Display titles of plugin surfaces bound to the connection: dock terminal
 * entries first (the user-renamable terminals a batch-send panel should
 * follow), then workbench tabs, deduplicated in order.
 */
export function pluginWorkbenchTitlesForConnection(tabs: ReadonlyArray<PluginConnectionSurfaceTab>, dockEntries: ReadonlyArray<PluginConnectionSurfaceDockEntry>, connectionId: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  const push = (title: string) => {
    if (!title || seen.has(title)) return;
    seen.add(title);
    titles.push(title);
  };
  for (const entry of dockEntries) {
    if (dockEntryReferencesPluginConnection(entry, connectionId)) push(entry.title);
  }
  for (const tab of tabs) {
    if (PLUGIN_SURFACE_TAB_MODES.has(tab.mode) && tabReferencesPluginConnection(tab, connectionId)) push(tab.title);
  }
  return titles;
}
