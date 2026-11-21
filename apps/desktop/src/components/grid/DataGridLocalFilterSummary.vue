<script setup lang="ts">
import { Filter, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";

export interface DataGridLocalFilterSummaryItem {
  columnIndex: number;
  columnName: string;
  values: string[];
  hiddenValueCount: number;
}

const props = defineProps<{
  count: number;
  summaries: DataGridLocalFilterSummaryItem[];
}>();

const emit = defineEmits<{
  clearAll: [];
  clearColumn: [columnIndex: number];
}>();

const { t } = useI18n();
</script>

<template>
  <div data-grid-local-filter-summary class="space-y-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1.5">
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2 text-xs font-medium text-primary">
        <Filter class="h-3.5 w-3.5 shrink-0" /><span class="truncate">{{ t("grid.localFiltersActive", { count: props.count }) }}</span>
      </div>
      <Button variant="ghost" size="sm" class="h-6 shrink-0 px-2 text-xs" @click="emit('clearAll')"><X class="mr-1 h-3.5 w-3.5" />{{ t("grid.clearLocalFiltersShort") }}</Button>
    </div>
    <div class="space-y-0.5">
      <div v-for="summary in props.summaries" :key="summary.columnIndex" class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_auto] items-center gap-1.5 rounded border border-primary/10 bg-background/70 px-2 py-0.5 text-xs">
        <span class="truncate font-medium text-foreground" :title="summary.columnName">{{ summary.columnName }}</span>
        <span class="min-w-0 truncate font-mono text-muted-foreground">
          <template v-for="(value, valueIndex) in summary.values" :key="valueIndex"
            ><span v-if="valueIndex > 0">, </span><span>{{ value }}</span></template
          >
          <span v-if="summary.hiddenValueCount">{{ t("grid.localFilterMoreValues", { count: summary.hiddenValueCount }) }}</span>
        </span>
        <Button variant="ghost" size="icon" class="h-5 w-5 text-muted-foreground hover:text-destructive" :title="t('grid.clearFilter')" :aria-label="t('grid.clearFilter')" @click="emit('clearColumn', summary.columnIndex)"><X class="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  </div>
</template>
