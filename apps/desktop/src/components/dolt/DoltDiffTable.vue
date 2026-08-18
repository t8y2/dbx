<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type CSSProperties } from "vue";
import DoltScrollArea from "@/components/dolt/DoltScrollArea.vue";
import type { QueryResult } from "@/types/database";
import type { DoltDiffColumnKind, DoltDiffRow } from "@/lib/dolt/doltVersionControl";
import type { DoltDiffCellTarget } from "@/lib/dolt/doltCellDiff";

type CellValue = QueryResult["rows"][number][number];

const props = defineProps<{
  columns: string[];
  columnKinds: DoltDiffColumnKind[];
  rows: DoltDiffRow[];
  side: "before" | "after";
  selectedCell?: DoltDiffCellTarget | null;
  columnWidths?: readonly number[];
  cellClass?: (rowIndex: number, columnIndex: number, row: CellValue[]) => string | undefined;
  headerClass?: (columnIndex: number, columnName: string) => string | undefined;
}>();

const emit = defineEmits<{
  "column-widths-change": [widths: number[]];
  "cell-select": [target: DoltDiffCellTarget];
  "cell-context-menu": [target: DoltDiffCellTarget, event: MouseEvent];
  "cell-open-details": [target: DoltDiffCellTarget];
}>();

const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 26;
const ROW_BUFFER = 8;
const COLUMN_BUFFER = 240;
const minimumColumnWidth = 72;
const maximumColumnWidth = 360;

const scrollArea = ref<InstanceType<typeof DoltScrollArea> | null>(null);
const measuredWidths = ref<number[]>([]);
const scrollTop = ref(0);
const scrollLeft = ref(0);
const viewportWidth = ref(0);
const viewportHeight = ref(0);
let activeResizeStop: (() => void) | undefined;
let scrollFrame = 0;

function sameWidths(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((width, index) => Math.abs(width - (right[index] ?? 0)) < 0.5);
}

function textWidth(value: unknown): number {
  const text = value === null || value === undefined ? "" : String(value);
  return Math.min(maximumColumnWidth, Math.max(minimumColumnWidth, text.length * 7 + 24));
}

function measureWidths(): number[] {
  const widths = props.columns.map(textWidth);
  for (const diffRow of props.rows) {
    const row = diffRow[props.side];
    for (let index = 0; index < widths.length; index += 1) widths[index] = Math.max(widths[index] ?? minimumColumnWidth, textWidth(row[index]));
  }
  return widths;
}

const effectiveWidths = computed(() => {
  if (props.columnWidths?.length === props.columns.length) return [...props.columnWidths];
  return measuredWidths.value.length === props.columns.length ? measuredWidths.value : measureWidths();
});
const columnOffsets = computed(() => {
  const offsets: number[] = [];
  let offset = 0;
  for (const width of effectiveWidths.value) {
    offsets.push(offset);
    offset += width;
  }
  return offsets;
});
const totalWidth = computed(() => effectiveWidths.value.reduce((sum, width) => sum + width, 0));
const totalHeight = computed(() => HEADER_HEIGHT + props.rows.length * ROW_HEIGHT);
const contentStyle = computed<CSSProperties>(() => ({ width: `${Math.max(totalWidth.value, 1)}px`, height: `${Math.max(totalHeight.value, HEADER_HEIGHT)}px` }));
const visibleRowStart = computed(() => Math.max(0, Math.floor(Math.max(0, scrollTop.value - HEADER_HEIGHT) / ROW_HEIGHT) - ROW_BUFFER));
const visibleRowEnd = computed(() => Math.min(props.rows.length, Math.ceil(Math.max(0, scrollTop.value - HEADER_HEIGHT + viewportHeight.value) / ROW_HEIGHT) + ROW_BUFFER));
function findVisibleColumnRange(): { start: number; end: number } {
  const left = Math.max(0, scrollLeft.value - COLUMN_BUFFER);
  const right = scrollLeft.value + viewportWidth.value + COLUMN_BUFFER;
  const widths = effectiveWidths.value;
  const offsets = columnOffsets.value;
  let start = 0;
  while (start < widths.length && (offsets[start] ?? 0) + (widths[start] ?? 0) < left) start += 1;
  let end = start;
  while (end < widths.length && (offsets[end] ?? 0) <= right) end += 1;
  return { start, end };
}
const visibleColumnRange = computed(findVisibleColumnRange);
const visibleColumns = computed(() => {
  const { start, end } = visibleColumnRange.value;
  return props.columns.slice(start, end).map((column, offset) => {
    const index = start + offset;
    return { column, index, kind: props.columnKinds[index], left: columnOffsets.value[index] ?? 0, width: effectiveWidths.value[index] ?? minimumColumnWidth };
  });
});
const visibleRows = computed(() =>
  props.rows.slice(visibleRowStart.value, visibleRowEnd.value).map((diffRow, offset) => {
    const rowIndex = visibleRowStart.value + offset;
    const row = diffRow[props.side];
    return { diffRow, row, rowIndex, values: visibleColumns.value.map(({ index }) => valueText(row[index])) };
  }),
);

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function cellTarget(rowIndex: number, columnIndex: number, diffRow: DoltDiffRow): DoltDiffCellTarget {
  return {
    rowIndex,
    columnIndex,
    side: props.side,
    columnName: props.columns[columnIndex] ?? "",
    columnKind: props.columnKinds[columnIndex] ?? "unchanged",
    rowKind: diffRow.kind,
    beforeValue: diffRow.before[columnIndex] ?? null,
    afterValue: diffRow.after[columnIndex] ?? null,
  };
}

function isSelected(rowIndex: number, columnIndex: number): boolean {
  const selected = props.selectedCell;
  return !!selected && selected.side === props.side && selected.rowIndex === rowIndex && selected.columnIndex === columnIndex;
}

function selectCell(rowIndex: number, columnIndex: number, diffRow: DoltDiffRow) {
  emit("cell-select", cellTarget(rowIndex, columnIndex, diffRow));
}

function openCellContextMenu(rowIndex: number, columnIndex: number, diffRow: DoltDiffRow, event: MouseEvent) {
  emit("cell-context-menu", cellTarget(rowIndex, columnIndex, diffRow), event);
}

function openCellDetails(rowIndex: number, columnIndex: number, diffRow: DoltDiffRow) {
  emit("cell-open-details", cellTarget(rowIndex, columnIndex, diffRow));
}

function initializeWidths() {
  const measured = measureWidths();
  if (!sameWidths(measuredWidths.value, measured)) measuredWidths.value = measured;
  if (!props.columnWidths?.length && measured.length) emit("column-widths-change", [...measured]);
}

function updateViewport(element = scrollArea.value?.scrollerElement()) {
  if (!element) return;
  viewportWidth.value = element.clientWidth;
  viewportHeight.value = element.clientHeight;
  scrollTop.value = element.scrollTop;
  scrollLeft.value = element.scrollLeft;
}

function onScroll(element: HTMLElement) {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    updateViewport(element);
  });
}

function startResize(columnIndex: number, event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  activeResizeStop?.();
  const startX = event.clientX;
  const startWidths = effectiveWidths.value.slice();
  const startWidth = startWidths[columnIndex] ?? minimumColumnWidth;
  let pendingClientX = startX;
  let resizeFrame = 0;
  const applyResize = () => {
    resizeFrame = 0;
    const next = startWidths.slice();
    next[columnIndex] = Math.min(maximumColumnWidth, Math.max(minimumColumnWidth, startWidth + pendingClientX - startX));
    measuredWidths.value = next;
    emit("column-widths-change", next);
  };
  const onMove = (moveEvent: PointerEvent) => {
    pendingClientX = moveEvent.clientX;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const stop = (stopEvent?: PointerEvent) => {
    if (stopEvent) pendingClientX = stopEvent.clientX;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    applyResize();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    if (activeResizeStop === stop) activeResizeStop = undefined;
  };
  activeResizeStop = stop;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}

watch(
  () => props.columnWidths,
  (widths) => {
    if (widths?.length === props.columns.length && !sameWidths(widths, measuredWidths.value)) measuredWidths.value = [...widths];
  },
  { deep: true },
);
watch(
  () => props.columns.join("\0"),
  () => nextTick(initializeWidths),
  { immediate: true },
);

onMounted(() => {
  initializeWidths();
  nextTick(updateViewport);
});
onUnmounted(() => {
  activeResizeStop?.();
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
});
</script>

<template>
  <DoltScrollArea ref="scrollArea" class="min-h-0 flex-1" scroller-class="dolt-diff-table-scroller" @scroll="onScroll" @resize="updateViewport">
    <div class="dolt-diff-table-content" :style="contentStyle">
      <div class="dolt-diff-table-header" :style="{ width: `${Math.max(totalWidth, 1)}px`, height: '28px' }">
        <div v-for="column in visibleColumns" :key="`header-${column.index}-${column.column}`" class="dolt-diff-table-header-cell" :class="headerClass?.(column.index, column.column)" :data-column-kind="column.kind" :style="{ left: `${column.left}px`, width: `${column.width}px` }">
          <span class="min-w-0 flex-1 truncate" :title="column.column">{{ column.column }}</span>
          <span class="dolt-diff-table-resize-handle" @pointerdown="startResize(column.index, $event)" />
        </div>
      </div>
      <div
        v-for="visibleRow in visibleRows"
        :key="`${visibleRow.rowIndex}-${visibleRow.diffRow.kind}`"
        class="dolt-diff-table-row"
        :class="{ 'dolt-diff-table-row-even': visibleRow.rowIndex % 2 === 1 }"
        :style="{ top: `${HEADER_HEIGHT + visibleRow.rowIndex * ROW_HEIGHT}px`, width: `${Math.max(totalWidth, 1)}px`, height: `${ROW_HEIGHT}px` }"
      >
        <div
          v-for="(column, visibleColumnIndex) in visibleColumns"
          :key="`${visibleRow.rowIndex}-${column.index}`"
          class="dolt-diff-table-cell"
          :class="[cellClass?.(visibleRow.rowIndex, column.index, visibleRow.row), { 'dolt-diff-table-cell-selected': isSelected(visibleRow.rowIndex, column.index) }]"
          :style="{ left: `${column.left}px`, width: `${column.width}px` }"
          :title="visibleRow.values[visibleColumnIndex]"
          @click="selectCell(visibleRow.rowIndex, column.index, visibleRow.diffRow)"
          @contextmenu="openCellContextMenu(visibleRow.rowIndex, column.index, visibleRow.diffRow, $event)"
          @dblclick="openCellDetails(visibleRow.rowIndex, column.index, visibleRow.diffRow)"
        >
          {{ visibleRow.values[visibleColumnIndex] }}
        </div>
      </div>
      <div v-if="rows.length === 0" class="dolt-diff-table-empty">{{ $t("doltVersionControl.noRowChanges") }}</div>
    </div>
  </DoltScrollArea>
</template>

<style scoped>
.dolt-diff-table-content {
  position: relative;
  min-width: 100%;
}
.dolt-diff-table-header {
  position: sticky;
  top: 0;
  z-index: 2;
  min-width: 100%;
  border-bottom: 1px solid var(--border);
  background: var(--background);
  font-size: 11px;
  font-weight: 600;
}
.dolt-diff-table-row {
  position: absolute;
  left: 0;
  min-width: 100%;
}
.dolt-diff-table-header-cell,
.dolt-diff-table-cell {
  position: absolute;
  top: 0;
  bottom: 0;
  box-sizing: border-box;
  min-width: 0;
  overflow: hidden;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
  padding: 5px 8px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dolt-diff-table-header-cell {
  display: flex;
  align-items: center;
}
.dolt-diff-table-cell {
  font-size: 12px;
  line-height: 16px;
  cursor: default;
  user-select: none;
}
.dolt-diff-table-cell-selected {
  z-index: 1;
  outline: 2px solid color-mix(in srgb, var(--primary) 78%, transparent);
  outline-offset: -2px;
}
.dolt-diff-table-row-even .dolt-diff-table-cell {
  background: color-mix(in srgb, var(--muted) 18%, transparent);
}
.dolt-diff-table-resize-handle {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
}
.dolt-diff-table-resize-handle:hover {
  background: color-mix(in srgb, var(--primary) 35%, transparent);
}
.dolt-diff-table-empty {
  position: sticky;
  left: 0;
  width: min(100%, 480px);
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
