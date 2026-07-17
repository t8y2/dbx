<script setup lang="ts">
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import LightDropdown, { type LightDropdownItem } from "@/components/ui/LightDropdown.vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_RESULT_PAGE_SIZE, MIN_RESULT_PAGE_SIZE } from "@/lib/dataGrid/paginationPageSize";
import DataGridExportMenu from "@/components/grid/DataGridExportMenu.vue";

const { t } = useI18n();

defineProps<{
  selectionSummary: { cellCount: number; rowCount: number } | null;
  selectionSummarySumText: string;
  loading: boolean;
  infiniteScrollEnabled: boolean;
  infiniteScrollAllLoaded: boolean;
  pageSize: number;
  pageSizeMenuItems: LightDropdownItem[];
  exportMenuItems: LightDropdownItem[];
  currentPage: number;
  canGoNextPage: boolean;
  canJumpLastPage: boolean;
}>();

const customPageSizeInput = defineModel<string>("customPageSizeInput", { default: "" });

const emit = defineEmits<{
  selectPageSize: [value: string];
  applyCustomPageSize: [];
  firstPage: [];
  previousPage: [];
  nextPage: [];
  lastPage: [];
  selectExport: [value: string];
}>();
</script>

<template>
  <div class="flex min-w-max items-center justify-end gap-1">
    <div v-if="selectionSummary" class="flex shrink-0 items-center gap-3 tabular-nums">
      <span class="shrink-0">{{ t("grid.selectionSum", { value: selectionSummarySumText }) }}</span>
      <div class="flex shrink-0 items-center gap-1">
        <span class="shrink-0">{{ t("grid.selectionCells", { count: selectionSummary.cellCount }) }}</span>
        <span class="shrink-0">{{ t("grid.rows", { count: selectionSummary.rowCount }) }}</span>
      </div>
    </div>
    <Loader2 v-if="loading" class="w-3 h-3 animate-spin text-muted-foreground" />
    <template v-if="infiniteScrollEnabled">
      <span v-if="infiniteScrollAllLoaded" class="text-xs text-muted-foreground shrink-0">{{ t("grid.allLoaded") }}</span>
    </template>
    <template v-if="!infiniteScrollEnabled">
      <LightDropdown
        :model-value="String(pageSize)"
        :items="pageSizeMenuItems"
        :trigger-label="`${pageSize}${t('grid.rowsPerPageShort')}`"
        trigger-class="inline-flex h-5 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
        content-class="w-36"
        :highlight-selected="false"
        check-position="none"
        align="end"
        @update:model-value="emit('selectPageSize', $event)"
      >
        <div class="bg-border -mx-1 my-1 h-px" />
        <div class="text-muted-foreground px-1.5 py-1 text-xs">{{ t("grid.customRowsPerPage") }}</div>
        <div class="flex items-center gap-1 px-1.5 pb-1" @click.stop @keydown.stop>
          <Input
            v-model="customPageSizeInput"
            type="number"
            inputmode="numeric"
            :min="MIN_RESULT_PAGE_SIZE"
            :max="MAX_RESULT_PAGE_SIZE"
            class="h-6 w-20 px-1.5 text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            @keydown.enter.prevent.stop="emit('applyCustomPageSize')"
          />
          <Tooltip>
            <TooltipTrigger as-child
              ><Button variant="outline" size="icon" class="h-6 w-6 shrink-0" :aria-label="t('grid.applyPageSize')" @click.stop="emit('applyCustomPageSize')"><Check class="h-3 w-3" /></Button
            ></TooltipTrigger>
            <TooltipContent side="bottom">{{ t("grid.applyPageSize") }}</TooltipContent>
          </Tooltip>
        </div>
      </LightDropdown>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="currentPage <= 1" @click="emit('firstPage')"><ChevronsLeft class="h-3 w-3" /></Button>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="currentPage <= 1" @click="emit('previousPage')"><ChevronLeft class="h-3 w-3" /></Button>
      <span class="shrink-0 tabular-nums">{{ currentPage }}</span>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="!canGoNextPage" @click="emit('nextPage')"><ChevronRight class="h-3 w-3" /></Button>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="!canJumpLastPage" @click="emit('lastPage')"><ChevronsRight class="h-3 w-3" /></Button>
    </template>
    <DataGridExportMenu :items="exportMenuItems" :label="t('grid.export')" :on-select="(value) => emit('selectExport', value)" />
  </div>
</template>
