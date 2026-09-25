<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Settings2 } from "@lucide/vue";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { usePluginShortcuts } from "@/composables/usePluginShortcuts";
import { usePluginShortcutPreferences } from "@/composables/usePluginShortcutPreferences";
import PluginIcon from "./PluginIcon.vue";
import type { PluginShortcutSettings } from "@/lib/plugins/pluginShortcuts";

const { t } = useI18n();
const settings = useSettingsStore();
const { toast } = useToast();
const { allEntries } = usePluginShortcuts();
const plugins = computed(() => [...new Map(allEntries.value.map((entry) => [entry.pluginId, entry])).values()]);
const { saving, update: persist } = usePluginShortcutPreferences();
async function update(patch: Partial<PluginShortcutSettings>) {
  try {
    await persist(patch);
  } catch (error) {
    toast(`${t("pluginPlatform.shortcutsSaveFailed")}: ${String(error)}`, 5000);
  }
}
async function togglePlugin(pluginId: string, visible: boolean) {
  try {
    await persist((current) => ({ hiddenPluginIds: visible ? current.hiddenPluginIds.filter((id) => id !== pluginId) : [...new Set([...current.hiddenPluginIds, pluginId])] }));
  } catch (error) {
    toast(`${t("pluginPlatform.shortcutsSaveFailed")}: ${String(error)}`, 5000);
  }
}
</script>

<template>
  <section class="space-y-4 rounded-xl border p-4" data-plugin-shortcut-settings>
    <div class="flex items-start gap-3">
      <div class="rounded-md bg-primary/10 p-2 text-primary"><Settings2 class="size-4" /></div>
      <div>
        <div class="text-sm font-medium">{{ t("pluginPlatform.globalSettingsTitle") }}</div>
        <div class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("pluginPlatform.shortcutsDescription") }}</div>
      </div>
    </div>
    <div class="flex items-center justify-between gap-4">
      <Label for="plugin-shortcuts-enabled" class="text-xs">{{ t("pluginPlatform.shortcutsEnabled") }}</Label>
      <Switch id="plugin-shortcuts-enabled" :model-value="settings.editorSettings.pluginShortcuts.enabled" :disabled="saving || !settings.isEditorSettingsLoaded" @update:model-value="update({ enabled: $event })" />
    </div>
    <div v-if="settings.editorSettings.pluginShortcuts.enabled" class="flex items-center justify-between gap-4">
      <Label for="plugin-shortcuts-position" class="text-xs">{{ t("pluginPlatform.shortcutsPosition") }}</Label>
      <Select :model-value="settings.editorSettings.pluginShortcuts.position" :disabled="saving || !settings.isEditorSettingsLoaded" @update:model-value="update({ position: String($event) as PluginShortcutSettings['position'] })">
        <SelectTrigger id="plugin-shortcuts-position" class="h-8 w-52 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="left-top">{{ t("pluginPlatform.shortcutsLeftTop") }}</SelectItem>
          <SelectItem value="left-bottom">{{ t("pluginPlatform.shortcutsLeftBottom") }}</SelectItem>
          <SelectItem value="right-top">{{ t("pluginPlatform.shortcutsRightTop") }}</SelectItem>
          <SelectItem value="right-bottom">{{ t("pluginPlatform.shortcutsRightBottom") }}</SelectItem>
          <SelectItem value="sidebar-bottom">{{ t("pluginPlatform.shortcutsBottom") }}</SelectItem>
          <SelectItem value="plugin-center">{{ t("pluginPlatform.shortcutsPluginCenter") }}</SelectItem>
          <SelectItem value="toolbar">{{ t("pluginPlatform.shortcutsToolbar") }}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <div v-if="settings.editorSettings.pluginShortcuts.enabled && settings.editorSettings.pluginShortcuts.position === 'toolbar'" class="flex items-center justify-between gap-4">
      <div>
        <Label for="plugin-shortcuts-toolbar-count" class="text-xs">{{ t("pluginPlatform.shortcutsToolbarCount") }}</Label>
        <p class="mt-1 text-xs text-muted-foreground">{{ t("pluginPlatform.shortcutsToolbarHint") }}</p>
      </div>
      <Select :model-value="String(settings.editorSettings.pluginShortcuts.toolbarCount)" :disabled="saving || !settings.isEditorSettingsLoaded" @update:model-value="update({ toolbarCount: Number($event) })">
        <SelectTrigger id="plugin-shortcuts-toolbar-count" class="h-8 w-24 shrink-0 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="count in 11" :key="count" :value="String(count - 1)">{{ count - 1 }}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <div v-if="plugins.length" class="space-y-2">
      <div class="text-xs font-medium">{{ t("pluginPlatform.shortcutsVisiblePlugins") }}</div>
      <div class="max-h-64 divide-y overflow-y-auto rounded-md border">
        <div v-for="(plugin, index) in plugins" :key="plugin.pluginId" class="flex items-center justify-between gap-3 px-3 py-2">
          <Label :for="`plugin-shortcut-visible-${index}`" class="flex min-w-0 items-center gap-2 text-xs">
            <PluginIcon :plugin-id="plugin.pluginId" :icon="plugin.icon" class="size-4 [&_svg]:text-current" />
            <span class="truncate">{{ plugin.pluginName }}</span>
          </Label>
          <Switch :id="`plugin-shortcut-visible-${index}`" :model-value="!settings.editorSettings.pluginShortcuts.hiddenPluginIds.includes(plugin.pluginId)" :disabled="saving || !settings.isEditorSettingsLoaded" @update:model-value="togglePlugin(plugin.pluginId, $event)" />
        </div>
      </div>
    </div>
  </section>
</template>
