<script setup lang="ts">
import { useId } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import { Switch } from "@/components/ui/switch";
import { supportsDdlStoragePreference } from "@/lib/sql/ddlStorage";
import type { DatabaseType } from "@/types/database";

const props = defineProps<{ databaseType?: DatabaseType; disabled?: boolean; preferences?: { compactDdlSql: boolean; includeDdlStorage: boolean; separateDdlIndexes: boolean } }>();
const settings = useSettingsStore();
const { t } = useI18n();
const id = useId();
const options = ["compactDdlSql", "includeDdlStorage", "separateDdlIndexes"] as const;
</script>

<template>
  <div v-if="supportsDdlStoragePreference(props.databaseType)" class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs">
    <div v-for="option in options" :key="option" class="flex items-center gap-2">
      <Switch :id="`${id}-${option}`" size="sm" :disabled="disabled" :model-value="(preferences ?? settings.editorSettings)[option]" @update:model-value="settings.updateEditorSettings({ [option]: $event })" />
      <label :for="`${id}-${option}`" class="cursor-pointer">{{ t(`contextMenu.${option}`) }}</label>
    </div>
  </div>
</template>
