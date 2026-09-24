import { computed, ref, type Ref } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { normalizePluginShortcutSettings, type PluginShortcutSettings } from "@/lib/plugins/pluginShortcuts";

const queues = new WeakMap<object, { tail: Promise<void>; pending: Ref<number> }>();

/** Serialize partial updates across the settings page, sorting and the resize handle. */
export function usePluginShortcutPreferences() {
  const settings = useSettingsStore();
  let queue = queues.get(settings);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: ref(0) };
    queues.set(settings, queue);
  }
  const state = queue;
  function update(patch: Partial<PluginShortcutSettings> | ((current: PluginShortcutSettings) => Partial<PluginShortcutSettings>)) {
    state.pending.value++;
    const operation = state.tail.then(async () => {
      const current = settings.editorSettings.pluginShortcuts;
      await settings.updateEditorSettingsAndPersist({ pluginShortcuts: normalizePluginShortcutSettings({ ...current, ...(typeof patch === "function" ? patch(current) : patch) }) });
    });
    state.tail = operation
      .catch(() => {})
      .finally(() => {
        state.pending.value--;
      });
    return operation;
  }
  return { update, saving: computed(() => state.pending.value > 0) };
}
