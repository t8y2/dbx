<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type CSSProperties } from "vue";
import { Check, Columns3, GripVertical, Search } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DataGridColumnLayoutOption } from "@/composables/useDataGridColumnLayout";
import { dragSortAutoScrollDelta } from "@/composables/useDragSort";
import {
  DATA_GRID_COLUMN_LAYOUT_DRAG_THRESHOLD,
  DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT,
  DATA_GRID_COLUMN_LAYOUT_VIEWPORT_HEIGHT,
  DATA_GRID_COLUMN_LAYOUT_VIRTUAL_THRESHOLD,
  dataGridColumnLayoutDropTarget,
  dataGridColumnLayoutVirtualWindow,
  type DataGridColumnLayoutHandle,
} from "./dataGridColumnLayoutPopover";

const props = withDefaults(
  defineProps<{
    grid?: DataGridColumnLayoutHandle;
    triggerClass?: string;
    compact?: boolean;
  }>(),
  {
    triggerClass: "",
    compact: false,
  },
);

const { t } = useI18n();
const popoverOpen = ref(false);
const columnSearch = ref("");
const listRef = ref<HTMLElement>();
const listScrollTop = ref(0);
const draggedDisplayPosition = ref<number | null>(null);
const dragTargetDisplayPosition = ref<number | null>(null);
const dragInsertionIndex = ref<number | null>(null);
const dragPreviewOption = ref<DataGridColumnLayoutOption | null>(null);
const dragPreviewStyle = ref<CSSProperties>();
let columnDragAutoScrollFrame = 0;

interface ColumnDragState {
  pointerId: number;
  fromDisplayPosition: number;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  active: boolean;
  handle: HTMLElement;
  option: DataGridColumnLayoutOption;
  previewOffsetX: number;
  previewOffsetY: number;
  previewWidth: number;
  previousBodyUserSelect: string;
}

let columnDragState: ColumnDragState | null = null;

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

function columnLayoutRowStyle(option: DataGridColumnLayoutOption): CSSProperties {
  const style: CSSProperties = { height: `${DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT}px` };
  const sourcePosition = draggedDisplayPosition.value;
  const targetPosition = dragTargetDisplayPosition.value;
  if (sourcePosition === null || targetPosition === null || option.displayPosition === sourcePosition) return style;
  let offset = 0;
  if (targetPosition < sourcePosition && option.displayPosition >= targetPosition && option.displayPosition < sourcePosition) offset = DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT;
  if (targetPosition > sourcePosition && option.displayPosition > sourcePosition && option.displayPosition <= targetPosition) offset = -DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT;
  if (!offset) return style;
  return { ...style, transform: `translateY(${offset}px)`, transition: "transform 120ms ease-out" };
}

function resetListScroll() {
  listScrollTop.value = 0;
  void nextTick(() => {
    if (listRef.value) listRef.value.scrollTop = 0;
  });
}

function onListScroll(event: Event) {
  listScrollTop.value = (event.currentTarget as HTMLElement).scrollTop;
}

function removeColumnDragListeners() {
  window.removeEventListener("pointermove", onWindowPointerMove, true);
  window.removeEventListener("pointerup", onWindowPointerUp, true);
  window.removeEventListener("pointercancel", onWindowPointerCancel, true);
  window.removeEventListener("blur", resetColumnDragState);
  window.removeEventListener("keydown", onWindowKeyDown, true);
}

function cancelColumnDragAutoScroll() {
  if (!columnDragAutoScrollFrame) return;
  window.cancelAnimationFrame(columnDragAutoScrollFrame);
  columnDragAutoScrollFrame = 0;
}

function resetColumnDragState() {
  const state = columnDragState;
  columnDragState = null;
  cancelColumnDragAutoScroll();
  removeColumnDragListeners();
  if (state?.active) document.body.style.userSelect = state.previousBodyUserSelect;
  if (state?.handle.hasPointerCapture?.(state.pointerId)) state.handle.releasePointerCapture(state.pointerId);
  draggedDisplayPosition.value = null;
  dragTargetDisplayPosition.value = null;
  dragInsertionIndex.value = null;
  dragPreviewOption.value = null;
  dragPreviewStyle.value = undefined;
}

function updateColumnDragTarget(clientY: number) {
  const state = columnDragState;
  const list = listRef.value;
  if (!state?.active || !list) return;
  const target = dataGridColumnLayoutDropTarget({
    clientY,
    listTop: list.getBoundingClientRect().top,
    scrollTop: list.scrollTop,
    itemCount: columnLayoutOptions.value.length,
    fromDisplayPosition: state.fromDisplayPosition,
  });
  dragInsertionIndex.value = target.insertionIndex;
  dragTargetDisplayPosition.value = target.toDisplayPosition;
}

function columnDragAutoScrollDelta(): number {
  const state = columnDragState;
  const list = listRef.value;
  if (!state?.active || !list) return 0;
  return dragSortAutoScrollDelta({
    pointerX: state.lastClientX,
    pointerY: state.lastClientY,
    rect: list.getBoundingClientRect(),
    scrollTop: list.scrollTop,
    clientHeight: list.clientHeight,
    scrollHeight: list.scrollHeight,
  });
}

function runColumnDragAutoScroll() {
  columnDragAutoScrollFrame = 0;
  const state = columnDragState;
  const list = listRef.value;
  const delta = columnDragAutoScrollDelta();
  if (!state?.active || !list || !delta) return;
  const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
  const previousScrollTop = list.scrollTop;
  list.scrollTop = Math.min(maxScrollTop, Math.max(0, previousScrollTop + delta));
  listScrollTop.value = list.scrollTop;
  if (list.scrollTop !== previousScrollTop) updateColumnDragTarget(state.lastClientY);
  scheduleColumnDragAutoScroll();
}

function scheduleColumnDragAutoScroll() {
  if (columnDragAutoScrollFrame || !columnDragAutoScrollDelta()) return;
  columnDragAutoScrollFrame = window.requestAnimationFrame(runColumnDragAutoScroll);
}

function updateColumnDragPreview(clientX: number, clientY: number) {
  const state = columnDragState;
  if (!state?.active) return;
  dragPreviewStyle.value = {
    height: `${DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT}px`,
    transform: `translate3d(${clientX - state.previewOffsetX}px, ${clientY - state.previewOffsetY}px, 0)`,
    width: `${state.previewWidth}px`,
  };
}

function activateColumnDrag(event: PointerEvent) {
  const state = columnDragState;
  if (!state || state.active) return;
  state.active = true;
  state.previousBodyUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  draggedDisplayPosition.value = state.fromDisplayPosition;
  dragPreviewOption.value = state.option;
  updateColumnDragPreview(event.clientX, event.clientY);
  updateColumnDragTarget(event.clientY);
}

function onWindowPointerMove(event: PointerEvent) {
  const state = columnDragState;
  if (!state || event.pointerId !== state.pointerId) return;
  state.lastClientX = event.clientX;
  state.lastClientY = event.clientY;
  const movedPastThreshold = Math.hypot(event.clientX - state.startClientX, event.clientY - state.startClientY) >= DATA_GRID_COLUMN_LAYOUT_DRAG_THRESHOLD;
  if (!state.active && !movedPastThreshold) return;
  event.preventDefault();
  activateColumnDrag(event);
  updateColumnDragPreview(event.clientX, event.clientY);
  updateColumnDragTarget(event.clientY);
  scheduleColumnDragAutoScroll();
}

function onWindowPointerUp(event: PointerEvent) {
  const state = columnDragState;
  if (!state || event.pointerId !== state.pointerId) return;
  const fromDisplayPosition = state.fromDisplayPosition;
  const toDisplayPosition = dragTargetDisplayPosition.value;
  const shouldCommit = state.active && toDisplayPosition !== null && toDisplayPosition !== fromDisplayPosition;
  if (state.active) event.preventDefault();
  resetColumnDragState();
  if (shouldCommit) props.grid?.moveDisplayableColumn(fromDisplayPosition, toDisplayPosition);
}

function onWindowPointerCancel(event: PointerEvent) {
  if (event.pointerId === columnDragState?.pointerId) resetColumnDragState();
}

function onWindowKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !columnDragState) return;
  event.preventDefault();
  resetColumnDragState();
}

function columnDragPreviewMetrics(handle: HTMLElement, event: PointerEvent) {
  const rowRect = handle.closest<HTMLElement>("[data-column-layout-row]")?.getBoundingClientRect();
  const listRect = listRef.value?.getBoundingClientRect();
  const previewWidth = rowRect?.width || listRect?.width || 288;
  const rowLeft = rowRect?.width ? rowRect.left : (listRect?.left ?? event.clientX);
  const rowTop = rowRect?.height ? rowRect.top : event.clientY - DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT / 2;
  return {
    previewOffsetX: Math.min(previewWidth, Math.max(0, event.clientX - rowLeft)),
    previewOffsetY: Math.min(DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT, Math.max(0, event.clientY - rowTop)),
    previewWidth,
  };
}

function startColumnDrag(option: DataGridColumnLayoutOption, event: PointerEvent) {
  if (!columnReorderEnabled.value || event.button !== 0) return;
  resetColumnDragState();
  const handle = event.currentTarget as HTMLElement;
  columnDragState = {
    pointerId: event.pointerId,
    fromDisplayPosition: option.displayPosition,
    startClientX: event.clientX,
    startClientY: event.clientY,
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    active: false,
    handle,
    option,
    ...columnDragPreviewMetrics(handle, event),
    previousBodyUserSelect: "",
  };
  window.addEventListener("pointermove", onWindowPointerMove, true);
  window.addEventListener("pointerup", onWindowPointerUp, true);
  window.addEventListener("pointercancel", onWindowPointerCancel, true);
  window.addEventListener("blur", resetColumnDragState);
  window.addEventListener("keydown", onWindowKeyDown, true);
  try {
    handle.setPointerCapture?.(event.pointerId);
  } catch (error) {
    console.warn("[DBX][DataGridColumnLayoutPopover:pointer-capture]", error);
  }
}

watch(columnSearch, () => {
  resetColumnDragState();
  resetListScroll();
});
watch(popoverOpen, (open) => {
  if (!open) resetColumnDragState();
});
onBeforeUnmount(resetColumnDragState);
</script>

<template>
  <Popover v-model:open="popoverOpen">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 shrink-0 gap-1 px-1.5 text-xs text-foreground hover:bg-accent"
        :class="[triggerClass, compact ? 'w-6 gap-0 px-0' : '', { 'bg-accent text-foreground': (grid?.hiddenColumnCount ?? 0) > 0 }]"
        :disabled="!grid"
        :title="t('grid.columnVisibility')"
        :aria-label="t('grid.columnVisibility')"
      >
        <Columns3 class="h-3.5 w-3.5" />
        <span v-if="!compact">{{ t("grid.columnVisibility") }}</span>
        <span v-if="!compact && (grid?.hiddenColumnCount ?? 0) > 0" class="tabular-nums"> {{ grid?.visibleColumnCount }}/{{ grid?.displayableColumnCount }} </span>
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
      <div ref="listRef" data-column-layout-list class="max-h-72 overflow-auto" :style="{ maxHeight: `${DATA_GRID_COLUMN_LAYOUT_VIEWPORT_HEIGHT}px` }" @scroll="onListScroll">
        <div class="relative" :style="listContentStyle">
          <div :style="renderedOptionsStyle">
            <div
              v-for="option in renderedOptions"
              :key="option.key"
              data-column-layout-row
              :data-display-position="option.displayPosition"
              class="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center px-1 text-xs hover:bg-accent"
              :class="{ 'opacity-25': draggedDisplayPosition === option.displayPosition }"
              :style="columnLayoutRowStyle(option)"
            >
              <button
                type="button"
                data-column-drag-handle
                class="flex h-5 w-5 touch-none items-center justify-center justify-self-center rounded border border-transparent text-muted-foreground"
                :class="columnReorderEnabled ? 'cursor-move hover:border-border hover:bg-background' : 'cursor-not-allowed opacity-30'"
                :disabled="!columnReorderEnabled"
                :aria-label="`${columnReorderEnabled ? t('grid.columnReorderHint') : t('grid.columnReorderSearchHint')} ${option.column}`"
                :title="columnReorderEnabled ? t('grid.columnReorderHint') : t('grid.columnReorderSearchHint')"
                @pointerdown.stop.prevent="startColumnDrag(option, $event)"
              >
                <GripVertical class="h-3.5 w-3.5" />
              </button>
              <button type="button" data-column-visibility-toggle class="grid h-full min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] items-center text-left" :aria-pressed="option.visible" @click="grid?.toggleColumnVisibility(option.index)">
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
          <div
            v-if="draggedDisplayPosition !== null && dragInsertionIndex !== null"
            data-column-drop-indicator
            class="pointer-events-none absolute left-1 right-1 z-10 h-0.5 -translate-y-1/2 rounded-full bg-primary shadow-sm"
            :style="{ top: `${dragInsertionIndex * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT}px` }"
          />
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
  <Teleport to="body">
    <div
      v-if="dragPreviewOption"
      data-column-drag-preview
      aria-hidden="true"
      class="pointer-events-none fixed left-0 top-0 z-[100] grid grid-cols-[1.5rem_1.5rem_minmax(0,1fr)] items-center rounded border bg-background px-1 text-xs shadow-lg ring-1 ring-primary/40 will-change-transform dark:bg-muted"
      :style="dragPreviewStyle"
    >
      <span class="flex h-5 w-5 items-center justify-center text-muted-foreground">
        <GripVertical class="h-3.5 w-3.5" />
      </span>
      <span class="flex h-4 w-4 items-center justify-center rounded border" :class="dragPreviewOption.visible ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-transparent'">
        <Check class="h-3 w-3 stroke-[3]" />
      </span>
      <span class="flex min-w-0 items-baseline gap-1.5">
        <span class="truncate font-mono text-xs">{{ dragPreviewOption.column }}</span>
        <span v-if="dragPreviewOption.comment" class="truncate text-[10px] text-muted-foreground">{{ dragPreviewOption.comment }}</span>
      </span>
    </div>
  </Teleport>
</template>
