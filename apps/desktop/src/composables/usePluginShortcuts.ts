import { computed, onScopeDispose, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import { collectPluginShortcuts, orderPluginShortcuts, type PluginShortcutEntry } from "@/lib/plugins/pluginShortcuts";
import { executePluginCommand } from "@/lib/plugins/pluginCommandRegistry";
import { setDockVisible, usePluginBottomDock } from "@/lib/plugins/pluginBottomDock";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

export function usePluginShortcuts() {
  const { locale } = useI18n();
  const settings = useSettingsStore();
  const query = useQueryStore();
  const dock = usePluginBottomDock();
  const registry = shallowRef(createFrontendPluginRegistry([]));
  const allEntries = computed(() => orderPluginShortcuts(collectPluginShortcuts(registry.value), settings.editorSettings.pluginShortcuts.order));
  const entries = computed(() => {
    const hidden = new Set(settings.editorSettings.pluginShortcuts.hiddenPluginIds);
    return allEntries.value.filter((entry) => !hidden.has(entry.pluginId));
  });
  let sequence = 0;
  async function refresh() {
    const current = ++sequence;
    try {
      const plugins = await api.listPlugins();
      if (current === sequence) registry.value = createFrontendPluginRegistry(plugins, locale.value);
    } catch (error) {
      if (current === sequence) registry.value = createFrontendPluginRegistry([]);
      console.warn("[DBX][plugin:shortcuts]", error);
    }
  }
  function hasSelectedPanel(entry: PluginShortcutEntry): boolean {
    const active = dock.entries.value.find((item) => item.id === dock.activeEntryId.value);
    return entry.command?.action.presentation === "panel" && active?.pluginId === entry.pluginId && active.workbenchContributionId === entry.command.action.workbench && active.commandId === entry.targetId && active.instanceKey === entry.command.action.instance_key;
  }
  function isActive(entry: PluginShortcutEntry): boolean {
    if (entry.command?.action.presentation === "panel") return dock.visible.value && hasSelectedPanel(entry);
    const tab = query.tabs.find((tab) => tab.id === query.activeTabId);
    if (entry.kind === "filesystem") return tab?.pluginFilesystem?.pluginId === entry.pluginId && tab.pluginFilesystem.providerId === entry.targetId;
    const target = entry.command?.action.workbench ?? entry.targetId;
    return tab?.pluginWorkbench?.pluginId === entry.pluginId && tab.pluginWorkbench.contributionId === target && (!entry.command || tab.pluginWorkbench.commandId === entry.targetId);
  }
  function open(entry: PluginShortcutEntry) {
    // Re-resolve before dispatch so removed/disabled entries cannot be executed.
    const current = entries.value.find((item) => item.id === entry.id);
    if (!current || current.disabled) return;
    if (current.kind === "command") {
      if (hasSelectedPanel(current)) {
        // Restoring chrome must keep the selected session, even when the
        // command's normal execution creates a new instance.
        setDockVisible(!dock.visible.value);
        return;
      }
      const result = executePluginCommand(registry.value, query, current.pluginId, current.targetId);
      if (result.error) throw new Error(result.error);
    } else if (current.kind === "workbench") {
      query.openPluginWorkbench(current.pluginId, current.targetId, { title: current.label });
    } else {
      query.openPluginFilesystem(current.pluginId, current.targetId, { title: current.label, rootUri: current.rootUri });
    }
  }
  const onChange = () => void refresh();
  watch(locale, onChange);
  window.addEventListener("dbx:plugins-changed", onChange);
  window.addEventListener("focus", onChange);
  onScopeDispose(() => {
    sequence++;
    window.removeEventListener("dbx:plugins-changed", onChange);
    window.removeEventListener("focus", onChange);
  });
  void refresh();
  return { entries, allEntries, open, isActive };
}
