<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, Copy, FileCode2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { useTabScroll } from "@/composables/useTabScroll";
import ResultSetNavigatorPopoverContent from "@/components/layout/ResultSetNavigatorPopoverContent.vue";
import { filterResultItems, type ResultItem } from "@/components/layout/resultSetNavigator";

const props = withDefaults(
  defineProps<{
    items: ResultItem[];
    activeIndex: number;
    active: boolean;
    busy?: boolean;
    canExportXlsx?: boolean;
    displayMode?: "tabs" | "list";
  }>(),
  {
    displayMode: "tabs",
  },
);
const emit = defineEmits<{
  select: [item: ResultItem];
  copySql: [items: ResultItem[]];
  copyQuerySql: [items: ResultItem[]];
  exportXlsx: [items: ResultItem[]];
}>();
const { t } = useI18n();
const scroller = ref<HTMLElement | null>(null);
const batchSearchInput = ref<HTMLInputElement | null>(null);
const open = ref(false);
const batchOpen = ref(false);
const batchSearch = ref("");
const selectedIndexes = ref<Set<number>>(new Set());
const { hasTabOverflow, scrollThumbLeftPercent, scrollThumbWidthPercent, isScrollbarDragging, updateScrollButtons, onTabsWheel, startScrollbarDrag } = useTabScroll(scroller);
const thumbStyle = computed(() => ({ left: `${scrollThumbLeftPercent.value}%`, width: `${scrollThumbWidthPercent.value}%` }));

const filteredBatchItems = computed(() => {
  return filterResultItems(props.items, batchSearch.value, t);
});
const selectedBatchItems = computed(() => props.items.filter((item) => selectedIndexes.value.has(item.index)));
// The active result may be a server message that tabularResultItems filters out;
// in that case no tabular item is active and the triggers fall back to the
// generic "result sets" label instead of faking the first item as active.
const activeItem = computed(() => props.items.find((item) => item.index === props.activeIndex));

function revealActive() {
  const container = scroller.value;
  const button = container?.querySelector<HTMLElement>('[data-active="true"]');
  if (container && button) {
    // Scroll only the strip; scrollIntoView can also move the surrounding result pane.
    const viewport = container.getBoundingClientRect();
    const bounds = button.getBoundingClientRect();
    if (bounds.left < viewport.left) container.scrollLeft -= viewport.left - bounds.left;
    else if (bounds.right > viewport.right) container.scrollLeft += bounds.right - viewport.right;
  }
  updateScrollButtons();
}

watch(
  () => [props.items, props.activeIndex, props.active, props.displayMode],
  () => nextTick(revealActive),
  { flush: "post", immediate: true },
);

function select(item: ResultItem) {
  emit("select", item);
  open.value = false;
}

function resetBatchSelection() {
  selectedIndexes.value = new Set(props.items.map((item) => item.index));
}

function onBatchOpenAutoFocus() {
  batchSearch.value = "";
  resetBatchSelection();
  batchSearchInput.value?.focus();
}

function setVisibleBatchSelection(selected: boolean) {
  const next = new Set(selectedIndexes.value);
  for (const item of filteredBatchItems.value) {
    if (selected) next.add(item.index);
    else next.delete(item.index);
  }
  selectedIndexes.value = next;
}

function toggleBatchItem(item: ResultItem) {
  const next = new Set(selectedIndexes.value);
  if (next.has(item.index)) next.delete(item.index);
  else next.add(item.index);
  selectedIndexes.value = next;
}

function emitBatch(action: "copySql" | "copyQuerySql" | "exportXlsx") {
  const items = selectedBatchItems.value;
  if (!items.length) return;
  if (action === "copySql") emit("copySql", items);
  else if (action === "copyQuerySql") emit("copyQuerySql", items);
  else emit("exportXlsx", items);
  batchOpen.value = false;
}

watch(
  () => props.items,
  () => {
    resetBatchSelection();
  },
  { immediate: true },
);
</script>

<template>
  <div data-result-set-tabs-region role="group" :aria-label="t('tabs.resultSets')" class="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden">
    <template v-if="displayMode === 'list'">
      <div v-if="items.length > 0" class="flex min-w-0 items-center gap-1">
        <Popover v-if="items.length > 1" v-model:open="open">
          <PopoverTrigger as-child>
            <Button
              variant="ghost"
              size="sm"
              class="h-6 max-w-56 shrink-0 gap-1 px-2 text-xs"
              :class="{ 'font-semibold text-foreground': active }"
              :data-active="active ? 'true' : undefined"
              :title="activeItem?.label || activeItem?.title || (activeItem ? t('tabs.resultN', { n: activeItem.n }) : t('tabs.resultSets'))"
              :aria-label="activeItem?.displayLabel || activeItem?.label || (activeItem ? t('tabs.resultN', { n: activeItem.n }) : t('tabs.resultSets'))"
            >
              <span class="truncate">{{ activeItem?.displayLabel || activeItem?.label || (activeItem ? t("tabs.resultN", { n: activeItem.n }) : t("tabs.resultSets")) }}</span>
              <ChevronDown class="h-3.5 w-3.5 shrink-0 opacity-70" />
            </Button>
          </PopoverTrigger>
          <ResultSetNavigatorPopoverContent align="start" :items="items" :active-index="activeIndex" :active="active" @select="select" />
        </Popover>
        <Button
          v-else
          variant="ghost"
          size="sm"
          class="h-6 max-w-56 shrink-0 px-2 text-xs"
          :class="{ 'font-semibold text-foreground': active }"
          :data-active="active ? 'true' : undefined"
          :title="activeItem?.label || activeItem?.title || (activeItem ? t('tabs.resultN', { n: activeItem.n }) : t('tabs.resultSets'))"
          :aria-label="activeItem?.displayLabel || activeItem?.label || (activeItem ? t('tabs.resultN', { n: activeItem.n }) : t('tabs.resultSets'))"
        >
          <span class="truncate">{{ activeItem?.displayLabel || activeItem?.label || (activeItem ? t("tabs.resultN", { n: activeItem.n }) : t("tabs.resultSets")) }}</span>
        </Button>
      </div>
    </template>
    <template v-else>
      <div class="relative h-full min-w-0 flex-1">
        <div ref="scroller" class="result-set-scroll flex h-full items-center gap-1 overflow-x-auto overflow-y-hidden px-1" @scroll="updateScrollButtons" @wheel="onTabsWheel">
          <LightTooltip v-for="item in items" :key="item.index" :text="item.label || item.title || t('tabs.resultN', { n: item.n })" :delay="150" :close-delay="0" nowrap>
            <Button size="sm" :variant="active && activeIndex === item.index ? 'default' : 'ghost'" class="h-6 max-w-48 shrink-0 px-2 text-xs" :data-active="active && activeIndex === item.index ? 'true' : undefined" :aria-pressed="active && activeIndex === item.index" @click="select(item)">
              <span class="truncate">{{ item.displayLabel || item.label || t("tabs.resultN", { n: item.n }) }}</span>
            </Button>
          </LightTooltip>
        </div>
        <div v-if="hasTabOverflow" class="result-set-scrollbar" :class="{ dragging: isScrollbarDragging }" @pointerdown="startScrollbarDrag">
          <div class="result-set-scrollbar-thumb" :style="thumbStyle" />
        </div>
      </div>
      <Popover v-if="items.length > 1" v-model:open="open">
        <PopoverTrigger as-child>
          <Button variant="ghost" size="sm" class="h-6 shrink-0 gap-1 px-2 text-xs" :title="t('tabs.allResults', { count: items.length })">
            {{ t("tabs.allResults", { count: items.length }) }}
            <ChevronDown class="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <ResultSetNavigatorPopoverContent align="end" :items="items" :active-index="activeIndex" :active="active" @select="select" />
      </Popover>
    </template>
    <Popover v-if="items.length > 1" v-model:open="batchOpen">
      <PopoverTrigger as-child>
        <Button variant="ghost" size="sm" class="h-6 shrink-0 gap-1 px-2 text-xs" :title="t('tabs.batchResultActions')">
          <Copy class="h-3.5 w-3.5" />
          <span class="hidden sm:inline">{{ t("tabs.batchResultActions") }}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" class="w-[32rem] max-h-[var(--reka-popover-content-available-height)] max-w-[calc(100vw-2rem)] gap-2 p-2" @open-auto-focus.prevent="onBatchOpenAutoFocus">
        <div class="flex items-center justify-between gap-2 border-b pb-2">
          <span class="shrink-0 text-xs font-semibold">{{ t("tabs.batchResultActions") }}</span>
          <input ref="batchSearchInput" v-model="batchSearch" type="search" class="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" :placeholder="t('tabs.searchResults')" :aria-label="t('tabs.searchResults')" />
          <span class="shrink-0 text-[11px] text-muted-foreground">{{ t("tabs.batchSelectedCount", { count: selectedBatchItems.length, total: items.length }) }}</span>
        </div>
        <div class="flex min-h-0 max-h-56 flex-col gap-1 overflow-y-auto py-1">
          <label v-for="item in filteredBatchItems" :key="item.index" class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent">
            <input type="checkbox" :checked="selectedIndexes.has(item.index)" @change="toggleBatchItem(item)" />
            <span class="min-w-0 flex-1 truncate">{{ item.displayLabel || item.label || t("tabs.resultN", { n: item.n }) }}</span>
            <span class="shrink-0 text-[10px] text-muted-foreground tabular-nums"
              >{{ item.result.rows.length }}<template v-if="item.result.has_more || item.result.truncated"> · {{ t("tabs.batchIncompleteResult") }}</template></span
            >
          </label>
          <p v-if="!filteredBatchItems.length" role="status" class="p-4 text-center text-xs text-muted-foreground">{{ t("tabs.noMatchingResults") }}</p>
        </div>
        <p class="text-[11px] text-muted-foreground">{{ t("tabs.batchLoadedRowsOnly") }}</p>
        <div class="flex flex-wrap items-center gap-1 border-t pt-2">
          <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="!filteredBatchItems.length" @click="setVisibleBatchSelection(true)">{{ t("tabs.selectAllResults") }}</Button>
          <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="!filteredBatchItems.length" @click="setVisibleBatchSelection(false)">{{ t("tabs.clearResultSelection") }}</Button>
          <span class="flex-1" />
          <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" :disabled="busy || selectedBatchItems.length === 0" @click="emitBatch('copyQuerySql')">
            <FileCode2 class="h-3.5 w-3.5" />
            {{ t("tabs.copyResultQueries") }}
          </Button>
          <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" :disabled="!canExportXlsx || busy || selectedBatchItems.length === 0" @click="emitBatch('exportXlsx')">
            {{ t("tabs.exportSelectedResultsXlsx") }}
          </Button>
          <Button size="sm" class="h-6 gap-1 px-2 text-xs" :disabled="busy || selectedBatchItems.length === 0" @click="emitBatch('copySql')">
            <Copy class="h-3.5 w-3.5" />
            {{ t("tabs.copyResultAsSql") }}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>

<style scoped>
.result-set-scroll {
  scrollbar-width: none;
}
.result-set-scroll::-webkit-scrollbar {
  display: none;
}
.result-set-scrollbar {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: 8px;
  cursor: pointer;
  touch-action: none;
}
.result-set-scrollbar-thumb {
  position: absolute;
  top: 3px;
  height: 3px;
  border-radius: 999px;
  background: var(--foreground);
  opacity: 0.38;
}
.result-set-scrollbar:hover .result-set-scrollbar-thumb,
.dragging .result-set-scrollbar-thumb {
  top: 1px;
  height: 6px;
  opacity: 0.58;
}
</style>
