<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingsStore, type DataGridColumnWidthMode } from "@/stores/settingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const columnWidthMode = computed(() => settingsStore.editorSettings.dataGridColumnWidthMode ?? "content");

function setColumnWidthMode(value: DataGridColumnWidthMode) {
  settingsStore.updateEditorSettings({ dataGridColumnWidthMode: value });
}
</script>

<template>
  <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
    <div class="min-w-0 flex items-center gap-2 font-medium">
      <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[11px] text-muted-foreground" aria-hidden="true">↔</span>
      <span>{{ t("grid.columnWidthMode") }}</span>
    </div>
    <div role="group" :aria-label="t('grid.columnWidthMode')" class="grid w-48 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
      <button
        v-for="mode in ['fill', 'content'] as const"
        :key="mode"
        type="button"
        class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-1.5 text-xs transition-colors"
        :class="columnWidthMode === mode ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
        :aria-pressed="columnWidthMode === mode"
        :data-column-width-mode="mode"
        :title="t(`grid.columnWidthMode${mode === 'fill' ? 'Fill' : 'Content'}`)"
        @click="setColumnWidthMode(mode)"
      >
        {{ t(`grid.columnWidthMode${mode === "fill" ? "Fill" : "Content"}`) }}
      </button>
    </div>
  </div>
</template>
