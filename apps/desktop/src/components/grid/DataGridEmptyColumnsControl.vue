<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";

const props = defineProps<{ count?: number; columnCount?: number }>();
const { t } = useI18n();
const settingsStore = useSettingsStore();
const enabled = computed(() => settingsStore.editorSettings.dataGridHideEmptyColumns === true);
const disabled = computed(() => !enabled.value && (!(props.count ?? 0) || (props.columnCount ?? 0) <= 1));
</script>

<template>
  <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs" :class="{ 'opacity-60': disabled }">
    <span class="min-w-0 font-medium"
      >{{ t("grid.hideEmptyColumns") }}<span v-if="count" class="text-muted-foreground tabular-nums"> ({{ count }})</span></span
    >
    <Switch size="sm" :model-value="enabled" :disabled="disabled" :aria-label="t('grid.hideEmptyColumns')" @update:model-value="settingsStore.updateEditorSettings({ dataGridHideEmptyColumns: $event })" />
  </div>
</template>
