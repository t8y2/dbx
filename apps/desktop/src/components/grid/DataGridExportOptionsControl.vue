<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";
import { Text, Upload } from "@lucide/vue";

const { t } = useI18n();
defineProps<{ queryResult?: boolean }>();
const settingsStore = useSettingsStore();
const options = [
  { key: "dataGridExportInToolbar", label: "grid.exportInToolbar" },
  { key: "dataGridLoadAllInToolbar", label: "grid.loadAllInToolbar" },
  { key: "showSaveResult", label: "grid.showSaveResult" },
  { key: "warnIncompleteExport", label: "grid.warnIncompleteExport" },
] as const;
</script>

<template>
  <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
    <span class="flex items-center gap-2 font-medium"><Upload class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{{ t("grid.defaultExportMode") }}</span>
    <div role="group" :aria-label="t('grid.defaultExportMode')" class="grid min-w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
      <button
        v-for="mode in ['immediate', 'queued'] as const"
        :key="mode"
        type="button"
        class="h-5 whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
        :class="settingsStore.editorSettings.defaultExportMode === mode ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
        :aria-pressed="settingsStore.editorSettings.defaultExportMode === mode"
        @click="settingsStore.updateEditorSettings({ defaultExportMode: mode })"
      >
        {{ t(mode === "immediate" ? "exportProgress.immediate" : "exportProgress.queue") }}
      </button>
    </div>
  </div>
  <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
    <span class="flex items-center gap-2 font-medium"><Text class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{{ t("grid.hideToolbarLabels") }}</span>
    <Switch size="sm" :model-value="settingsStore.editorSettings.dataGridHideToolbarLabels" :aria-label="t('grid.hideToolbarLabels')" @update:model-value="settingsStore.updateEditorSettings({ dataGridHideToolbarLabels: $event })" />
  </div>
  <template v-for="option in options" :key="option.key">
    <div v-if="queryResult || option.key === 'warnIncompleteExport'" class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
      <span class="font-medium">{{ t(option.label) }}</span>
      <Switch size="sm" :model-value="settingsStore.editorSettings[option.key]" :aria-label="t(option.label)" @update:model-value="settingsStore.updateEditorSettings({ [option.key]: $event })" />
    </div>
  </template>
</template>
