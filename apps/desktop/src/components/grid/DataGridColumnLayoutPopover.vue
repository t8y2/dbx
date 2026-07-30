<script setup lang="ts">
import { computed, nextTick, ref, watch, type CSSProperties } from "vue";
import { Check, Columns3, GripVertical, Search } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DataGridColumnLayoutOption } from "@/composables/useDataGridColumnLayout";
import { DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT, DATA_GRID_COLUMN_LAYOUT_VIEWPORT_HEIGHT, DATA_GRID_COLUMN_LAYOUT_VIRTUAL_THRESHOLD, dataGridColumnLayoutVirtualWindow, type DataGridColumnLayoutHandle } from "./dataGridColumnLayoutPopover";

const props = withDefaults(
  defineProps<{
    grid?: DataGridColumnLayoutHandle;
    triggerClass?: string;
  }>(),
  {
    triggerClass: "",
  },
);

const { t } = useI18n();
const columnSearch = ref("");
const listRef = ref<HTMLElement>();
const listScrollTop = ref(0);
const draggedDisplayPosition = ref<number | null>(null);
const dragTargetDisplayPosition = ref<number | null>(null);
let suppressClickUntil = 0;

const columnLayoutOptions = computed(() => props.grid?.filteredColumnLayoutOptions(columnSearch.value) ?? []);
const columnReorderEnabled = computed(() => columnSearch.value.trim() === "");
const virtualized = computed(() => columnLayoutOptions.value.length > DATA_GRID_COLUMN_LAYOUT_VIRTUAL_THRESHOLD);
const virtualWindow = computed(() =>
  dataGridColumnLayoutVirtualWindow({
    itemCount: columnLayoutOptions.value.length,
    scrollTop: listScrollTop.value,
  }),
);
const renderedOptions = computed(() => {
  if (!virtualized.value) return columnLayoutOptions.value;
  return columnLayoutOptions.value.slice(virtualWindow.value.start, virtualWindow.value.end);
});
const listContentStyle = computed<CSSProperties | undefined>(() => {
  if (!virtualized.value) return undefined;
  return { height: `${virtualWindow.value.totalHeight}px`, position: "relative" };
});
const renderedOptionsStyle = computed<CSSProperties | undefined>(() => {
  if (!virtualized.value) return undefined;
  return {
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    transform: `translateY(${virtualWindow.value.offsetTop}px)`,
  };
});

function resetListScroll() {
  listScrollTop.value = 0;
  void nextTick(() => {
    if (listRef.value) listRef.value.scrollTop = 0;
  });
}

function onListScroll(event: Event) {
  listScrollTop.value = (event.currentTarget as HTMLElement).scrollTop;
}

function startColumnDrag(option: DataGridColumnLayoutOption, event: DragEvent) {
  if (!columnReorderEnabled.value || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  draggedDisplayPosition.value = option.displayPosition;
  dragTargetDisplayPosition.value = option.displayPosition;
  suppressClickUntil = Date.now() + 300;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(option.displayPosition));
}

function updateColumnDragTarget(option: DataGridColumnLayoutOption, event: DragEvent) {
  if (!columnReorderEnabled.value || draggedDisplayPosition.value === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dragTargetDisplayPosition.value = option.displayPosition;
}

function finishColumnDrop(option: DataGridColumnLayoutOption, event: DragEvent) {
  if (!columnReorderEnabled.value || draggedDisplayPosition.value === null) return;
  event.preventDefault();
  const fromDisplayPosition = draggedDisplayPosition.value;
  clearColumnDrag();
  if (fromDisplayPosition !== option.displayPosition) {
    props.grid?.moveDisplayableColumn(fromDisplayPosition, option.displayPosition);
  }
}

function clearColumnDrag() {
  draggedDisplayPosition.value = null;
  dragTargetDisplayPosition.value = null;
  suppressClickUntil = Date.now() + 100;
}

function toggleColumn(option: DataGridColumnLayoutOption) {
  if (Date.now() < suppressClickUntil) return;
  props.grid?.toggleColumnVisibility(option.index);
}

watch(columnSearch, resetListScroll);
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 shrink-0 gap-1 px-1.5 text-xs text-foreground hover:bg-accent"
        :class="[triggerClass, { 'bg-accent text-foreground': (grid?.hiddenColumnCount ?? 0) > 0 }]"
        :disabled="!grid"
        :title="t('grid.columnVisibility')"
        :aria-label="t('grid.columnVisibility')"
      >
        <Columns3 class="h-3.5 w-3.5" />
        {{ t("grid.columnVisibility") }}
        <span v-if="(grid?.hiddenColumnCount ?? 0) > 0" class="tabular-nums"> {{ grid?.visibleColumnCount }}/{{ grid?.displayableColumnCount }} </span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-72 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-xl" @click.stop @keydown.stop>
      <div class="border-b bg-muted/40 px-2 py-1.5">
        <div class="flex items-center justify-between gap-2">
          <div class="text-xs font-semibold">{{ t("grid.columnVisibility") }}</div>
          <div class="text-[10px] text-muted-foreground tabular-nums">{{ grid?.visibleColumnCount ?? 0 }}/{{ grid?.displayableColumnCount ?? 0 }}</div>
        </div>
      </div>
      <div class="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input v-model="columnSearch" autocapitalize="off" autocorrect="off" spellcheck="false" class="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('grid.searchColumns')" />
      </div>
      <div ref="listRef" class="max-h-72 overflow-auto py-0.5" :style="{ maxHeight: `${DATA_GRID_COLUMN_LAYOUT_VIEWPORT_HEIGHT}px` }" @scroll="onListScroll">
        <div :style="listContentStyle">
          <div :style="renderedOptionsStyle">
            <button
              v-for="option in renderedOptions"
              :key="option.key"
              type="button"
              class="grid w-full grid-cols-[1.25rem_1.5rem_minmax(0,1fr)] items-center px-1.5 text-left text-xs hover:bg-accent"
              :class="{
                'cursor-grab active:cursor-grabbing': columnReorderEnabled,
                'bg-accent/80': dragTargetDisplayPosition === option.displayPosition && draggedDisplayPosition !== option.displayPosition,
                'opacity-60': draggedDisplayPosition === option.displayPosition,
              }"
              :style="{ height: `${DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT}px` }"
              :draggable="columnReorderEnabled"
              :aria-pressed="option.visible"
              @click="toggleColumn(option)"
              @dragstart="startColumnDrag(option, $event)"
              @dragover="updateColumnDragTarget(option, $event)"
              @drop="finishColumnDrop(option, $event)"
              @dragend="clearColumnDrag"
            >
              <GripVertical class="h-3.5 w-3.5 text-muted-foreground" :class="{ 'opacity-30': !columnReorderEnabled }" :title="columnReorderEnabled ? t('grid.columnReorderHint') : t('grid.columnReorderSearchHint')" />
              <span class="flex h-4 w-4 items-center justify-center rounded border" :class="option.visible ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-transparent'">
                <Check class="h-3 w-3 stroke-[3]" />
              </span>
              <span class="flex min-w-0 items-baseline gap-1.5">
                <span class="truncate font-mono text-xs" :title="option.column">{{ option.column }}</span>
                <span v-if="option.comment" class="truncate text-[10px] text-muted-foreground" :title="option.comment">{{ option.comment }}</span>
              </span>
            </button>
          </div>
        </div>
        <div v-if="columnLayoutOptions.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">
          {{ t("grid.noSearchResults") }}
        </div>
      </div>
      <div class="flex flex-col gap-1 border-t bg-muted/30 px-2 py-1.5">
        <span class="text-[11px] leading-4 text-muted-foreground">
          {{ t("grid.columnVisibilityHint") }}
          {{ columnReorderEnabled ? t("grid.columnReorderHint") : t("grid.columnReorderSearchHint") }}
        </span>
        <div class="flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="(grid?.displayableColumnCount ?? 0) <= 1" @click="grid?.invertColumnVisibility()">
            {{ t("grid.invertColumnVisibility") }}
          </Button>
          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="!grid?.hasCustomColumnOrder" @click="grid?.resetColumnOrder()">
            {{ t("grid.resetColumnOrder") }}
          </Button>
          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="(grid?.hiddenColumnCount ?? 0) === 0" @click="grid?.showAllColumns()">
            {{ t("grid.showAllColumns") }}
          </Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
