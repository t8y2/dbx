<script setup lang="ts">
import { Code } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();
</script>

<template>
  <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs" :title="t('grid.showStatusSqlHint')">
    <span class="min-w-0 flex items-center gap-2 font-medium">
      <Code class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {{ t("grid.showStatusSql") }}
    </span>
    <Switch size="sm" :model-value="settingsStore.editorSettings.showDataGridStatusSql" :aria-label="t('grid.showStatusSql')" @update:model-value="settingsStore.updateEditorSettings({ showDataGridStatusSql: $event })" />
  </div>
</template>
