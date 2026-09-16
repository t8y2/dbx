<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const DOLT_DIFF_PAGE_SIZE_OPTIONS = [20, 50, 100, 500, 1000];

const props = defineProps<{
  currentPage: number;
  pageSize: number;
  totalRows: number;
  loading: boolean;
}>();

const emit = defineEmits<{
  pageChange: [page: number];
  pageSizeChange: [pageSize: number];
}>();

const { t } = useI18n();
const pageInput = ref(String(props.currentPage));
const maximumPage = computed(() => Math.max(1, Math.ceil(props.totalRows / props.pageSize)));
const pageSizeOptions = computed(() => [...new Set([...DOLT_DIFF_PAGE_SIZE_OPTIONS, props.pageSize])].sort((left, right) => left - right));

watch(
  () => props.currentPage,
  (page) => (pageInput.value = String(page)),
);

function requestPage(page: number) {
  const normalized = Math.min(maximumPage.value, Math.max(1, Math.floor(page)));
  pageInput.value = String(normalized);
  if (normalized !== props.currentPage) emit("pageChange", normalized);
}

function applyPageInput() {
  const page = Number(pageInput.value);
  if (!Number.isSafeInteger(page) || page < 1) {
    pageInput.value = String(props.currentPage);
    return;
  }
  requestPage(page);
}

function selectPageSize(value: unknown) {
  const pageSize = Number(value);
  if (Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize !== props.pageSize) emit("pageSizeChange", pageSize);
}
</script>

<template>
  <div class="flex min-h-[30px] shrink-0 items-center gap-2 border-t bg-muted/30 px-1.5 py-0.5 pl-2">
    <span class="text-[11px] text-muted-foreground">{{ t("grid.totalRows", { count: totalRows }) }}</span>
    <div class="ml-auto flex min-w-max items-center gap-1">
      <Loader2 v-if="loading" class="h-3 w-3 animate-spin text-muted-foreground" />
      <Select :model-value="String(pageSize)" :disabled="loading" @update:model-value="selectPageSize">
        <SelectTrigger class="h-6 w-[82px] border-0 bg-transparent px-1.5 text-[11px] shadow-none focus:ring-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="size in pageSizeOptions" :key="size" :value="String(size)">{{ size }}{{ t("grid.rowsPerPageShort") }}</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="loading || currentPage <= 1" :title="t('grid.page', { page: 1 })" @click="requestPage(1)"><ChevronsLeft class="h-3.5 w-3.5" /></Button>
      <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="loading || currentPage <= 1" :title="t('grid.page', { page: Math.max(1, currentPage - 1) })" @click="requestPage(currentPage - 1)"><ChevronLeft class="h-3.5 w-3.5" /></Button>
      <Input
        v-model="pageInput"
        type="number"
        inputmode="numeric"
        min="1"
        :max="maximumPage"
        :disabled="loading"
        :aria-label="t('grid.jumpToPage')"
        class="h-6 w-14 px-1 text-center text-[11px] tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        @keydown.enter.prevent.stop="applyPageInput"
        @blur="applyPageInput"
      />
      <span class="px-0.5 text-[11px] text-muted-foreground">/ {{ maximumPage }}</span>
      <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="loading || currentPage >= maximumPage" :title="t('grid.page', { page: Math.min(maximumPage, currentPage + 1) })" @click="requestPage(currentPage + 1)"><ChevronRight class="h-3.5 w-3.5" /></Button>
      <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="loading || currentPage >= maximumPage" :title="t('grid.page', { page: maximumPage })" @click="requestPage(maximumPage)"><ChevronsRight class="h-3.5 w-3.5" /></Button>
    </div>
  </div>
</template>
