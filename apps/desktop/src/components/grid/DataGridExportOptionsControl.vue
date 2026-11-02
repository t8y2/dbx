<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";

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
  <template v-for="option in options" :key="option.key">
    <div v-if="queryResult || option.key === 'warnIncompleteExport'" class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
      <span class="font-medium">{{ t(option.label) }}</span>
      <Switch size="sm" :model-value="settingsStore.editorSettings[option.key]" :aria-label="t(option.label)" @update:model-value="settingsStore.updateEditorSettings({ [option.key]: $event })" />
    </div>
  </template>
</template>
