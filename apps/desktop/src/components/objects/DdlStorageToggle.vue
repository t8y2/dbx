<script setup lang="ts">
import { useId } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import { Switch } from "@/components/ui/switch";
import type { DatabaseType } from "@/types/database";

defineProps<{ databaseType?: DatabaseType; disabled?: boolean }>();
const settings = useSettingsStore();
const { t } = useI18n();
const id = useId();
</script>

<template>
  <div v-if="databaseType === 'oceanbase-oracle'" class="flex shrink-0 items-center gap-2 text-xs" :title="t('contextMenu.excludeDdlStorageHint')">
    <Switch :id="id" size="sm" :disabled="disabled" :model-value="settings.editorSettings.excludeDdlStorage !== false" @update:model-value="settings.updateEditorSettings({ excludeDdlStorage: $event })" />
    <label :for="id" class="cursor-pointer">{{ t("contextMenu.excludeDdlStorage") }}</label>
  </div>
</template>
