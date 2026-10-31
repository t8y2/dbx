<script setup lang="ts">
import { Check, Copy, ChevronDown, ChevronLeft, ChevronRight, ChevronsDown, ChevronsLeft, ChevronsRight, Loader2, Sigma } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import LightDropdown, { type LightDropdownItem } from "@/components/ui/LightDropdown.vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_RESULT_PAGE_SIZE, MIN_RESULT_PAGE_SIZE } from "@/lib/dataGrid/paginationPageSize";
import { useSettingsStore, type DataGridSelectionSummaryMetric } from "@/stores/settingsStore";
import DataGridExportMenu from "@/components/grid/DataGridExportMenu.vue";

const { t } = useI18n();
const settingsStore = useSettingsStore();

const props = withDefaults(
  defineProps<{
    paginationEnabled?: boolean;
    selectionSummary: { cellCount: number; rowCount: number } | null;
    selectionSummarySumText: string;
    selectionSummaryAverageText: string;
    selectionSummaryMinText: string;
    selectionSummaryMaxText: string;
    selectionSummaryCount?: number;
    selectionSummaryDistinctCount?: number;
    // 拖拽选区期间聚合值只是占位符，父组件把该状态传下来，值不可复制
    selectionSummaryPending?: boolean;
    loading: boolean;
    infiniteScrollEnabled: boolean;
    infiniteScrollAllLoaded: boolean;
    loadAllRowsActive: boolean;
    loadAllRowsEnabled: boolean;
    canLoadAllRows: boolean;
    canExport?: boolean;
    pageSize: number;
    defaultPageSize: number;
    pageSizeMenuItems: LightDropdownItem[];
    exportMenuItems: LightDropdownItem[];
    exportWarning?: string;
    currentPage: number;
    maxPage?: number;
    canGoNextPage: boolean;
    canJumpLastPage: boolean;
  }>(),
  { paginationEnabled: true, loadAllRowsActive: false, loadAllRowsEnabled: true, canLoadAllRows: false, canExport: true, selectionSummaryPending: false },
);

const customPageSizeInput = defineModel<string>("customPageSizeInput", { default: "" });
const pageInput = ref(String(props.currentPage));
const maximumInputPage = computed(() => {
  const pageSize = Math.max(1, Math.trunc(props.pageSize));
  const maximumSafeOffsetPage = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number.MAX_SAFE_INTEGER / pageSize) + 1);
  if (typeof props.maxPage !== "number" || !Number.isFinite(props.maxPage) || props.maxPage < 1) return maximumSafeOffsetPage;
  return Math.min(maximumSafeOffsetPage, Math.floor(props.maxPage));
});

const emit = defineEmits<{
  selectPageSize: [value: string];
  applyCustomPageSize: [];
  firstPage: [];
  previousPage: [];
  nextPage: [];
  jumpPage: [page: number];
  lastPage: [];
  loadAllRows: [];
  selectExport: [value: string];
  applyCustomPageSizeAndSetDefault: [];
  // 载荷是聚合值当前显示出来的文本，保证复制到的就是用户看到的那个数
  copySelectionSummary: [text: string];
}>();

const selectionMetrics = computed<Array<{ key: DataGridSelectionSummaryMetric; label: string; value: string }>>(() => [
  { key: "sum", label: t("grid.selectionStatisticsSum"), value: props.selectionSummarySumText },
  { key: "average", label: t("grid.selectionStatisticsAverage"), value: props.selectionSummaryAverageText },
  { key: "min", label: t("grid.selectionStatisticsMin"), value: props.selectionSummaryMinText },
  { key: "max", label: t("grid.selectionStatisticsMax"), value: props.selectionSummaryMaxText },
  { key: "count", label: t("grid.selectionStatisticsCount"), value: props.selectionSummaryPending ? "…" : String(props.selectionSummaryCount ?? 0) },
  { key: "distinct", label: t("grid.selectionStatisticsDistinct"), value: props.selectionSummaryPending ? "…" : String(props.selectionSummaryDistinctCount ?? 0) },
  { key: "cells", label: t("grid.selectionStatisticsCells"), value: String(props.selectionSummary?.cellCount ?? 0) },
  { key: "rows", label: t("grid.selectionStatisticsRows"), value: String(props.selectionSummary?.rowCount ?? 0) },
]);

const selectedMetric = computed(() => selectionMetrics.value.find((metric) => metric.key === settingsStore.editorSettings.dataGridSelectionSummaryMetric) ?? selectionMetrics.value[0]!);
const selectedMetricText = computed(() => `${selectedMetric.value.label}: ${selectedMetric.value.value}`);

function selectSummaryMetric(key: string) {
  const metric = selectionMetrics.value.find((item) => item.key === key);
  if (metric) settingsStore.updateEditorSettings({ dataGridSelectionSummaryMetric: metric.key });
}

function copySelectionSummaryValue(text: string) {
  if (props.selectionSummaryPending) return;
  emit("copySelectionSummary", text);
}

watch(
  () => props.currentPage,
  (page) => {
    pageInput.value = String(page);
  },
);
watch(
  () => props.loading,
  (loading, wasLoading) => {
    if (wasLoading && !loading) pageInput.value = String(props.currentPage);
  },
);

function applyPageInput() {
  const page = Number(pageInput.value);
  if (!Number.isSafeInteger(page) || page < 1) {
    pageInput.value = String(props.currentPage);
    return;
  }
  const targetPage = Math.min(page, maximumInputPage.value);
  pageInput.value = String(targetPage);
  if (targetPage !== props.currentPage) emit("jumpPage", targetPage);
}

function handlePageInputKeydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  applyPageInput();
}
</script>

<template>
  <div class="flex min-w-0 items-center justify-end gap-1">
    <Popover v-if="selectionSummary">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="inline-flex h-5 max-w-36 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="t('grid.selectionStatistics')"
          :title="`${t('grid.selectionStatistics')}: ${selectedMetricText}`"
          data-selection-summary-trigger
        >
          <Sigma class="h-3 w-3 shrink-0" aria-hidden="true" />
          <span class="truncate tabular-nums">{{ selectedMetricText }}</span>
          <ChevronDown class="h-3 w-3 shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" :collision-padding="8" class="w-64 max-w-[calc(100vw-1rem)] max-h-[var(--reka-popover-content-available-height)] overflow-y-auto gap-1 p-2 text-xs" :aria-label="t('grid.selectionStatistics')" data-selection-summary-details @click.stop>
        <div class="flex items-center justify-between gap-3 border-b px-2 pb-2 pt-1">
          <span class="shrink-0 text-muted-foreground">{{ t("grid.selectionStatisticsDisplayLabel") }}</span>
          <Select :model-value="selectedMetric.key" data-selection-summary-display-control @update:model-value="selectSummaryMetric(String($event ?? ''))">
            <SelectTrigger size="sm" class="h-7 min-w-0 flex-1 text-xs" :aria-label="t('grid.selectionStatisticsDisplayLabel')" data-selection-summary-display>
              <SelectValue>{{ selectedMetric.label }}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end" class="max-h-72" :hide-scroll-buttons="true">
              <SelectItem v-for="metric in selectionMetrics" :key="metric.key" :value="metric.key" class="text-xs">{{ metric.label }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <dl class="divide-y divide-border/50 tabular-nums" :aria-busy="selectionSummaryPending">
          <div v-for="metric in selectionMetrics" :key="metric.key">
            <dt class="sr-only">{{ metric.label }}</dt>
            <dd class="relative min-w-0">
              <button
                type="button"
                class="group grid w-full min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)_12px] items-baseline gap-3 rounded px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:text-muted-foreground"
                :title="selectionSummaryPending ? undefined : `${t('grid.copyValue')}: ${metric.label}: ${metric.value}`"
                :disabled="selectionSummaryPending"
                :data-selection-summary-copy="metric.key"
                :data-selection-summary-sum="metric.key === 'sum' ? '' : undefined"
                :data-selection-summary-average="metric.key === 'average' ? '' : undefined"
                :data-selection-summary-min="metric.key === 'min' ? '' : undefined"
                :data-selection-summary-max="metric.key === 'max' ? '' : undefined"
                @click="copySelectionSummaryValue(metric.value)"
              >
                <span v-if="!selectionSummaryPending" class="sr-only">{{ t("grid.copyValue") }}: </span>
                <span class="text-muted-foreground">{{ metric.label }}</span>
                <span class="min-w-0 break-all text-right font-medium" :data-selection-summary-value="metric.key">{{ metric.value }}</span>
                <Copy class="h-3 w-3 self-center opacity-0 group-hover:opacity-70 group-focus-visible:opacity-70" aria-hidden="true" />
              </button>
            </dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
    <Loader2 class="w-3 h-3 shrink-0 text-muted-foreground" :class="loading ? 'animate-spin' : 'invisible'" aria-hidden="true" />
    <template v-if="paginationEnabled && (infiniteScrollEnabled || loadAllRowsActive || infiniteScrollAllLoaded)">
      <span v-if="infiniteScrollAllLoaded" class="text-xs text-muted-foreground shrink-0">{{ t("grid.allLoaded") }}</span>
    </template>
    <template v-if="paginationEnabled && !infiniteScrollEnabled && !loadAllRowsActive">
      <LightDropdown
        :model-value="String(pageSize)"
        :items="pageSizeMenuItems"
        :trigger-label="`${pageSize}${t('grid.rowsPerPageShort')}`"
        trigger-class="inline-flex h-5 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
        content-class="w-52"
        :highlight-selected="false"
        check-position="none"
        align="end"
        @update:model-value="emit('selectPageSize', $event)"
      >
        <div class="bg-border -mx-1 my-1 h-px" />
        <div class="px-2 pt-2 text-xs font-medium text-foreground">{{ t("grid.customRowsPerPage") }}</div>
        <div class="px-2 pb-2 text-[11px] text-muted-foreground">{{ t("grid.currentAndDefaultPageSize", { current: pageSize, default: defaultPageSize }) }}</div>
        <div class="flex items-center gap-1.5 px-2 pb-2" @pointerdown.stop @click.stop @keydown.stop>
          <Input
            v-model="customPageSizeInput"
            type="number"
            inputmode="numeric"
            :min="MIN_RESULT_PAGE_SIZE"
            :max="MAX_RESULT_PAGE_SIZE"
            class="h-7 flex-1 px-2 text-sm tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            @keydown.enter.prevent.stop="emit('applyCustomPageSize')"
          />
          <Tooltip>
            <TooltipTrigger as-child
              ><Button variant="outline" size="icon" class="h-7 w-7 shrink-0" :aria-label="t('grid.applyForThisQuery')" @click.stop="emit('applyCustomPageSize')"><Check class="h-3.5 w-3.5" /></Button
            ></TooltipTrigger>
            <TooltipContent side="bottom">{{ t("grid.applyPageSize") }}</TooltipContent>
          </Tooltip>
        </div>
        <div class="flex gap-1.5 border-t px-2 py-2">
          <button type="button" class="flex-1 whitespace-nowrap rounded-md border px-2 py-1.5 text-center text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground" @click.stop="emit('applyCustomPageSize')">{{ t("grid.applyForThisQuery") }}</button>
          <button type="button" class="flex-1 whitespace-nowrap rounded-md bg-primary px-2 py-1.5 text-center text-xs text-primary-foreground hover:bg-primary/90" @click.stop="emit('applyCustomPageSizeAndSetDefault')">{{ t("grid.applyAndSetDefault") }}</button>
        </div>
      </LightDropdown>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="loading || currentPage <= 1" @click="emit('firstPage')"><ChevronsLeft class="h-3 w-3" /></Button>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="loading || currentPage <= 1" @click="emit('previousPage')"><ChevronLeft class="h-3 w-3" /></Button>
      <Input
        v-model="pageInput"
        type="number"
        inputmode="numeric"
        :min="1"
        :max="maximumInputPage"
        :disabled="loading"
        :aria-label="t('grid.jumpToPage')"
        class="h-5 w-14 shrink-0 px-1 text-center text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        @keydown="handlePageInputKeydown"
      />
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="loading || !canGoNextPage" @click="emit('nextPage')"><ChevronRight class="h-3 w-3" /></Button>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="loading || !canJumpLastPage" @click="emit('lastPage')"><ChevronsRight class="h-3 w-3" /></Button>
    </template>
    <Tooltip v-if="paginationEnabled && loadAllRowsEnabled">
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="loading || !canLoadAllRows" :aria-label="t('grid.loadAllAndGoToLastRow')" @click="emit('loadAllRows')">
          <ChevronsDown class="h-3 w-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ t("grid.loadAllAndGoToLastRow") }}</TooltipContent>
    </Tooltip>
    <DataGridExportMenu v-if="canExport" :items="exportMenuItems" :warning="exportWarning" :label="t('grid.export')" :on-select="(value) => emit('selectExport', value)" />
  </div>
</template>
