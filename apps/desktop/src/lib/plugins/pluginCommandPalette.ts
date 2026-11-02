// commandPalette surface (HOST_PLUGIN_UI_SPEC §5): map the plugin's `menus` contribution —
// commands with location === "commandPalette" derive into quick-open entries; execution goes through
// the host-authoritative executePluginCommand chain (command/workbench re-validation and context injection live there).
// Purely generic logic: label/description/provenance all come from registry declarations — no business-specific fields.
import { onScopeDispose, ref, shallowRef, watch } from "vue";
import * as api from "@/lib/backend/api";
import i18n from "@/i18n";
import { createFrontendPluginRegistry, type FrontendPluginRegistry } from "./frontendPlugin";
import { executePluginCommand, type PluginCommandExecutionResult } from "./pluginCommandRegistry";
import { useQueryStore } from "@/stores/queryStore";
import type { InstalledPlugin, PluginCommandContribution } from "@/types/database";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

/** Entry shape returned by FrontendPluginRegistry.listPaletteMenuCommands(). */
export interface PluginPaletteCommandEntry {
  plugin: InstalledPlugin;
  command: PluginCommandContribution;
  order: number;
}

/** Derives quick-open entries from palette declarations: label = command copy, provenance via description and the right-side plugin-name badge. */
export function pluginCommandPaletteItems(entries: readonly PluginPaletteCommandEntry[]): QuickOpenItem[] {
  return entries.map(({ plugin, command }) => ({
    id: `plugin-command-${plugin.manifest.id}-${command.id}`,
    type: "plugin_command" as const,
    label: command.label,
    description: command.description || plugin.manifest.name,
    connectionId: "",
    pluginId: plugin.manifest.id,
    commandId: command.id,
    pluginName: plugin.manifest.name,
    // Search matching: command label, description and source plugin name all participate in quick-open matching/pinyin.
    searchText: [command.label, command.description, plugin.manifest.name].filter(Boolean).join(" "),
  }));
}

/**
 * Plugin command palette data source: derived from installed plugins; on install/uninstall/replace (plugin center broadcasts
 * dbx:plugins-changed), window focus or locale change. Execution lazily resolves
 * queryStore (same approach as usePluginToolbarCommands; plain host tests need no Pinia).
 */
export function usePluginCommandPalette() {
  const items = ref<QuickOpenItem[]>([]);
  // shallowRef: the registry is a class instance with private fields — a deep ref's UnwrapRef would break its nominal type.
  const registry = shallowRef<FrontendPluginRegistry | null>(null);

  async function refresh(): Promise<void> {
    try {
      const installedPlugins = await api.listPlugins();
      const nextRegistry = createFrontendPluginRegistry(installedPlugins, i18n.global.locale.value);
      registry.value = nextRegistry;
      items.value = pluginCommandPaletteItems(nextRegistry.listPaletteMenuCommands());
    } catch (cause) {
      console.warn("[DBX][plugin:palette-commands]", cause);
      registry.value = null;
      items.value = [];
    }
  }

  /** Executes one plugin command from quick-open; errors are returned to the caller for display. */
  function open(item: QuickOpenItem): PluginCommandExecutionResult {
    if (item.type !== "plugin_command" || !item.pluginId || !item.commandId) return { error: "Item is not a plugin command" };
    if (!registry.value) return { error: "Plugin registry is not ready" };
    return executePluginCommand(registry.value, useQueryStore(), item.pluginId, item.commandId);
  }

  watch(
    () => i18n.global.locale.value,
    () => void refresh(),
  );
  const onPluginsChanged = () => void refresh();
  window.addEventListener("dbx:plugins-changed", onPluginsChanged);
  window.addEventListener("focus", onPluginsChanged);
  onScopeDispose(() => {
    window.removeEventListener("dbx:plugins-changed", onPluginsChanged);
    window.removeEventListener("focus", onPluginsChanged);
  });
  void refresh();

  return { items, registry, refresh, open };
}
