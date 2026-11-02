<script setup lang="ts">
import { Pin } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();
</script>

<template>
  <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs" :title="t('grid.freezeFirstColumnGloballyHint')">
    <span class="min-w-0 flex items-center gap-2 font-medium">
      <Pin class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {{ t("grid.freezeFirstColumnGlobally") }}
    </span>
    <Switch size="sm" :model-value="settingsStore.editorSettings.dataGridFreezeFirstColumn" :aria-label="t('grid.freezeFirstColumnGlobally')" @update:model-value="settingsStore.updateEditorSettings({ dataGridFreezeFirstColumn: $event })" />
  </div>
</template>
