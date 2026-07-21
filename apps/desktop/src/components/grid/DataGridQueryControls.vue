<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { Filter, Plus, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import DataGridConditionEditor from "@/components/grid/DataGridConditionEditor.vue";
import DataGridFilterBuilder from "@/components/grid/DataGridFilterBuilder.vue";
import type { DataGridConditionColumnOption } from "@/composables/useDataGridConditionEditor";
import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";
import type { DataGridConditionHistoryScope } from "@/lib/dataGrid/dataGridConditionHistory";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import { clampSearchSplitWidth } from "@/lib/dataGrid/dataGridSearchSplit";

type LocalFilterSummary = {
  columnIndex: number;
  columnName: string;
  values: string[];
  hiddenValueCount: number;
};

const props = defineProps<{
  whereInput: string;
  orderByInput: string;
  columns: readonly string[];
  conditionColumns: readonly DataGridConditionColumnOption[];
  historyScope: DataGridConditionHistoryScope;
  canUseWhereSearch: boolean;
  compact: boolean;
  leadingBorder: boolean;
  filterBuilderOpen: boolean;
  filterButtonActive: boolean;
  filterButtonCount: number;
  hasLocalColumnFilters: boolean;
  localFilterCount: number;
  localFilterSummaries: LocalFilterSummary[];
  rules: DataGridStructuredFilterRule[];
  filteredColumns: string[];
  modeOptions: Array<{ value: DataGridContextFilterMode; labelKey: string }>;
  columnSearch: string;
  applyWhere: (value?: string) => void | boolean | Promise<void | boolean>;
  applyOrderBy: (value?: string) => void | boolean | Promise<void | boolean>;
  clearOrderBy: () => void | Promise<void>;
}>();

const emit = defineEmits<{
  "update:whereInput": [value: string];
  "update:orderByInput": [value: string];
  "update:filterBuilderOpen": [value: boolean];
  "update:columnSearch": [value: string];
  ensureRule: [];
  addRule: [];
  applyFilters: [];
  resetFilters: [];
  clearFilters: [];
  removeRule: [id: string];
  updateRule: [id: string, patch: Partial<DataGridStructuredFilterRule>];
  clearLocalFilter: [columnIndex?: number];
}>();

const { t } = useI18n();
const containerRef = ref<HTMLDivElement>();
const whereWidth = ref<number | null>(null);
const resizing = ref(false);
let resizeStartX = 0;
let resizeStartWidth = 0;

const wherePaneStyle = computed(() => (whereWidth.value == null ? {} : { flex: `0 0 ${whereWidth.value}px` }));

function containerWidth(): number {
  return containerRef.value?.getBoundingClientRect().width ?? 0;
}

function onResizeStart(event: MouseEvent) {
  const width = containerWidth();
  if (width <= 0) return;
  event.preventDefault();
  resizing.value = true;
  resizeStartX = event.clientX;
  resizeStartWidth = clampSearchSplitWidth({ containerWidth: width, desiredWidth: whereWidth.value ?? undefined });
  whereWidth.value = resizeStartWidth;
  document.body.classList.add("select-none", "cursor-col-resize");
  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", onResizeEnd);
}

function onResizeMove(event: MouseEvent) {
  if (!resizing.value) return;
  const width = containerWidth();
  if (width <= 0) return;
  whereWidth.value = clampSearchSplitWidth({ containerWidth: width, desiredWidth: resizeStartWidth + event.clientX - resizeStartX });
}

function onResizeEnd() {
  resizing.value = false;
  document.body.classList.remove("select-none", "cursor-col-resize");
  window.removeEventListener("mousemove", onResizeMove);
  window.removeEventListener("mouseup", onResizeEnd);
}

function resetWidth() {
  const width = containerWidth();
  whereWidth.value = width > 0 ? clampSearchSplitWidth({ containerWidth: width }) : null;
}

function updateRule(id: string, patch: Partial<DataGridStructuredFilterRule>) {
  emit("updateRule", id, patch);
}

function clearWhere() {
  emit("clearFilters");
}

onUnmounted(onResizeEnd);
</script>

<template>
  <div ref="containerRef" class="flex flex-1 min-w-0">
    <div class="flex flex-1 items-center gap-1 px-2 py-0.5 min-w-0 relative" :class="{ 'border-l': leadingBorder }" :style="wherePaneStyle">
      <Popover :open="filterBuilderOpen" @update:open="emit('update:filterBuilderOpen', $event)">
        <PopoverTrigger as-child>
          <button
            type="button"
            class="relative flex h-5 w-5 -translate-x-1 shrink-0 items-center justify-center rounded border text-[11px] font-medium transition-colors"
            :class="filterButtonActive ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground'"
            :disabled="!canUseWhereSearch"
            @click="emit('ensureRule')"
          >
            <Filter class="h-3 w-3" />
            <span v-if="filterButtonCount" class="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-none text-primary-foreground">{{ filterButtonCount }}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" class="w-[480px] max-w-[calc(100vw-24px)] gap-3 p-3">
          <div class="flex items-center justify-between gap-3">
            <div class="text-xs font-medium text-foreground">{{ t("grid.filter") }}</div>
            <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="emit('addRule')"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("grid.filterBuilderAddRule") }}</Button>
          </div>

          <div v-if="hasLocalColumnFilters" class="space-y-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2">
            <div class="flex items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-2 text-xs font-medium text-primary">
                <Filter class="h-3.5 w-3.5 shrink-0" /><span class="truncate">{{ t("grid.localFiltersActive", { count: localFilterCount }) }}</span>
              </div>
              <Button variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-xs" @click="emit('clearLocalFilter')"><X class="mr-1 h-3.5 w-3.5" />{{ t("grid.clearLocalFiltersShort") }}</Button>
            </div>
            <div class="space-y-1">
              <div v-for="summary in localFilterSummaries" :key="summary.columnIndex" class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_auto] items-center gap-2 rounded border border-primary/10 bg-background/70 px-2 py-1 text-xs">
                <span class="truncate font-medium text-foreground" :title="summary.columnName">{{ summary.columnName }}</span>
                <span class="min-w-0 truncate font-mono text-muted-foreground">
                  <template v-for="(value, valueIndex) in summary.values" :key="valueIndex"
                    ><span v-if="valueIndex > 0">, </span><span>{{ value }}</span></template
                  >
                  <span v-if="summary.hiddenValueCount">{{ t("grid.localFilterMoreValues", { count: summary.hiddenValueCount }) }}</span>
                </span>
                <Button variant="ghost" size="icon" class="h-6 w-6 text-muted-foreground hover:text-destructive" :title="t('grid.clearFilter')" @click="emit('clearLocalFilter', summary.columnIndex)"><X class="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          </div>

          <DataGridFilterBuilder
            :rules="rules"
            :columns="[...columns]"
            :filtered-columns="filteredColumns"
            :mode-options="modeOptions"
            :column-search="columnSearch"
            :disabled="!canUseWhereSearch"
            :show-header="false"
            @add="emit('addRule')"
            @apply="emit('applyFilters')"
            @reset="emit('resetFilters')"
            @clear="emit('clearFilters')"
            @remove="emit('removeRule', $event)"
            @update-rule="updateRule"
            @update:column-search="emit('update:columnSearch', $event)"
          />
        </PopoverContent>
      </Popover>
      <DataGridConditionEditor
        :model-value="whereInput"
        kind="where"
        :columns="conditionColumns"
        :history-scope="historyScope"
        placeholder="WHERE"
        :history-empty-text="t('grid.conditionHistoryEmpty')"
        :history-no-matches-text="t('grid.conditionHistoryNoMatches')"
        :disabled="!canUseWhereSearch"
        :compact="compact"
        :apply="applyWhere"
        :clear="clearWhere"
        @update:model-value="emit('update:whereInput', $event)"
      />
    </div>
    <button
      type="button"
      class="group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center border-l border-r border-border/80 bg-muted/15 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      aria-label="Resize WHERE and ORDER BY"
      @mousedown="onResizeStart"
      @dblclick.stop="resetWidth"
    >
      <span class="h-5 w-px bg-border group-hover:bg-primary/60" />
    </button>
    <div class="flex flex-1 items-center px-2 py-0.5 border-r min-w-0">
      <DataGridConditionEditor
        :model-value="orderByInput"
        kind="orderBy"
        :columns="conditionColumns"
        :history-scope="historyScope"
        placeholder="ORDER BY"
        :history-empty-text="t('grid.conditionHistoryEmpty')"
        :history-no-matches-text="t('grid.conditionHistoryNoMatches')"
        :compact="compact"
        :apply="applyOrderBy"
        :clear="clearOrderBy"
        @update:model-value="emit('update:orderByInput', $event)"
      />
    </div>
  </div>
</template>
