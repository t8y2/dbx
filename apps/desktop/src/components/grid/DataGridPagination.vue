<script setup lang="ts">
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import LightDropdown, { type LightDropdownItem } from "@/components/ui/LightDropdown.vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_RESULT_PAGE_SIZE, MIN_RESULT_PAGE_SIZE } from "@/lib/dataGrid/paginationPageSize";
import DataGridExportMenu from "@/components/grid/DataGridExportMenu.vue";

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    paginationEnabled?: boolean;
    selectionSummary: { cellCount: number; rowCount: number } | null;
    selectionSummarySumText: string;
    loading: boolean;
    infiniteScrollEnabled: boolean;
    infiniteScrollAllLoaded: boolean;
    pageSize: number;
    pageSizeMenuItems: LightDropdownItem[];
    exportMenuItems: LightDropdownItem[];
    currentPage: number;
    maxPage?: number;
    canGoNextPage: boolean;
    canJumpLastPage: boolean;
  }>(),
  { paginationEnabled: true },
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
  selectExport: [value: string];
}>();

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
  <div class="flex min-w-max items-center justify-end gap-1">
    <div v-if="selectionSummary" class="flex shrink-0 items-center gap-3 tabular-nums">
      <span class="shrink-0">{{ t("grid.selectionSum", { value: selectionSummarySumText }) }}</span>
      <div class="flex shrink-0 items-center gap-1">
        <span class="shrink-0">{{ t("grid.selectionCells", { count: selectionSummary.cellCount }) }}</span>
        <span class="shrink-0">{{ t("grid.rows", { count: selectionSummary.rowCount }) }}</span>
      </div>
    </div>
    <Loader2 v-if="loading" class="w-3 h-3 animate-spin text-muted-foreground" />
    <template v-if="paginationEnabled && infiniteScrollEnabled">
      <span v-if="infiniteScrollAllLoaded" class="text-xs text-muted-foreground shrink-0">{{ t("grid.allLoaded") }}</span>
    </template>
    <template v-if="paginationEnabled && !infiniteScrollEnabled">
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
    <DataGridExportMenu :items="exportMenuItems" :label="t('grid.export')" :on-select="(value) => emit('selectExport', value)" />
  </div>
</template>
