import { computed, nextTick, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { columnOrderKeysForIndexes, isDefaultColumnOrder, moveVisibleColumnIndex, orderedColumnIndexes } from "@/lib/dataGrid/dataGridColumnOrder";
import { columnHeaderCanvasPointerDisabled, columnHeaderClickShouldBeSuppressed, columnHeaderPreviewOffsetForColumn, columnHeaderTooltipDisabled } from "@/lib/dataGrid/dataGridColumnHeaderInteraction";
import {
  loadDataGridColumnOrder,
  loadDataGridColumnFrozenState,
  loadTableDataGridColumnOrder,
  notifyTableDataGridColumnOrderChanged,
  removeDataGridColumnOrder,
  removeDataGridColumnFrozenCount,
  removeTableDataGridColumnOrder,
  saveDataGridColumnOrder,
  saveDataGridColumnFrozenCount,
  saveTableDataGridColumnOrder,
  type TableDataGridColumnOrderChangedDetail,
} from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import { filterColumnVisibilityOptions, hiddenColumnIndexesWithAllNullColumns, invertedHiddenColumnIndexes, nextHiddenColumnIndexes, removeAutoHiddenColumnIndexes, visibleColumnIndexesForFilter } from "@/lib/dataGrid/dataGridColumnVisibility";

export type RenderedDataGridColumn = {
  visibleColIdx: number;
  actualColIdx: number;
  name: string;
};

export type DataGridHorizontalColumnWindow = {
  start: number;
  end: number;
  beforeWidth: number;
  afterWidth: number;
};

type ColumnHeaderDragState = {
  sourceVisibleIndex: number;
  targetVisibleIndex: number;
  startX: number;
  startY: number;
  currentX: number;
  columnRects: { visibleIndex: number; left: number; width: number }[];
  dragging: boolean;
};

export function dataGridColumnOffsets(widths: readonly number[]): number[] {
  const offsets = Array.from({ length: widths.length + 1 }, () => 0);
  for (let index = 0; index < widths.length; index++) offsets[index + 1] = offsets[index] + (widths[index] ?? 0);
  return offsets;
}

export function dataGridHorizontalColumnWindow(options: { widths: readonly number[]; offsets: readonly number[]; columnCount: number; scrollLeft: number; viewportWidth: number; rowNumberWidth: number; bufferPx: number }): DataGridHorizontalColumnWindow {
  const { widths, offsets, columnCount } = options;
  if (columnCount === 0 || widths.length === 0) return { start: 0, end: 0, beforeWidth: 0, afterWidth: 0 };

  const viewportStart = Math.max(0, options.scrollLeft - options.rowNumberWidth - options.bufferPx);
  const viewportEnd = Math.max(options.viewportWidth, 1) + Math.max(0, options.scrollLeft - options.rowNumberWidth) + options.bufferPx;
  let low = 0;
  let high = columnCount - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((offsets[mid + 1] ?? 0) < viewportStart) low = mid + 1;
    else high = mid;
  }
  const start = low;
  let end = start;
  while (end < columnCount && (offsets[end] ?? 0) < viewportEnd) end++;

  const columnsWidth = offsets[columnCount] ?? 0;
  const visibleWidth = offsets[end] ?? offsets[start] ?? 0;
  return { start, end, beforeWidth: offsets[start] ?? 0, afterWidth: Math.max(0, columnsWidth - visibleWidth) };
}

export function useDataGridColumnLayoutState(options: {
  columns: MaybeRefOrGetter<readonly string[]>;
  sourceColumns?: MaybeRefOrGetter<readonly (string | undefined)[] | undefined>;
  commentByColumn?: MaybeRefOrGetter<ReadonlyMap<string, string>>;
  displayableColumnIndexes: MaybeRefOrGetter<readonly number[]>;
  allNullColumnIndexes: MaybeRefOrGetter<readonly number[]>;
  columnOrderKeys: MaybeRefOrGetter<readonly string[]>;
  layoutScopeKey: MaybeRefOrGetter<string>;
  tableScopeKey: MaybeRefOrGetter<string>;
  hideNullColumns?: MaybeRefOrGetter<boolean>;
  onHideNullColumnsChange?: (value: boolean) => void;
  onRefreshMetrics?: () => void;
}) {
  const hiddenColumnIndexes = ref<Set<number>>(new Set());
  const localNullColumnsHidden = ref(false);
  const nullColumnsHidden = computed(() => (options.hideNullColumns === undefined ? localNullColumnsHidden.value : toValue(options.hideNullColumns)));
  const autoHiddenNullColumnIndexes = ref<Set<number>>(new Set());
  const persistedColumnOrderKeys = ref<string[]>([]);
  const frozenColumnCount = ref(0);
  // 冻结选中列前的列序快照，取消冻结时还原
  const columnOrderSnapshotBeforeFreeze = ref<string[] | null>(null);
  const orderedDisplayableColumnIndexes = computed(() => orderedColumnIndexes({ availableIndexes: toValue(options.displayableColumnIndexes), columnKeys: toValue(options.columnOrderKeys), orderedKeys: persistedColumnOrderKeys.value }));
  const visibleColumnIndexes = computed(() => visibleColumnIndexesForFilter(orderedDisplayableColumnIndexes.value, hiddenColumnIndexes.value));
  const displayableColumnCount = computed(() => toValue(options.displayableColumnIndexes).length);
  const hiddenColumnCount = computed(() => displayableColumnCount.value - visibleColumnIndexes.value.length);
  const allNullColumnCount = computed(() => toValue(options.allNullColumnIndexes).length);
  const hasCustomColumnOrder = computed(() => !isDefaultColumnOrder(toValue(options.displayableColumnIndexes), orderedDisplayableColumnIndexes.value));
  const canToggleAllNullColumns = computed(() => nullColumnsHidden.value || (toValue(options.allNullColumnIndexes).length > 0 && displayableColumnCount.value > 1));

  function filteredColumnVisibilityOptions(query: string) {
    const displayable = new Set(toValue(options.displayableColumnIndexes));
    return filterColumnVisibilityOptions(toValue(options.columns), query, { sourceColumns: toValue(options.sourceColumns), commentByColumn: toValue(options.commentByColumn) }).filter((option) => displayable.has(option.index));
  }
  function isColumnVisible(columnIndex: number) {
    return !hiddenColumnIndexes.value.has(columnIndex);
  }
  function toggleColumnVisibility(columnIndex: number) {
    hiddenColumnIndexes.value = nextHiddenColumnIndexes({ columnIndex, hiddenIndexes: hiddenColumnIndexes.value, totalColumns: displayableColumnCount.value });
  }
  function showAllColumns() {
    hiddenColumnIndexes.value = new Set();
  }
  function invertColumnVisibility() {
    hiddenColumnIndexes.value = invertedHiddenColumnIndexes([...toValue(options.displayableColumnIndexes)], hiddenColumnIndexes.value);
  }
  function loadColumnOrder() {
    const tableScopeKey = toValue(options.tableScopeKey);
    const tableOrder = tableScopeKey ? loadTableDataGridColumnOrder(tableScopeKey) : [];
    persistedColumnOrderKeys.value = tableOrder.length ? tableOrder : loadDataGridColumnOrder(toValue(options.layoutScopeKey), toValue(options.columnOrderKeys));
  }
  function loadFrozenColumnCount() {
    const state = loadDataGridColumnFrozenState(toValue(options.layoutScopeKey));
    frozenColumnCount.value = Math.min(state.frozenCount, visibleColumnIndexes.value.length);
    columnOrderSnapshotBeforeFreeze.value = state.orderBeforeFreeze;
  }
  function setFrozenColumnCount(count: number) {
    const clampedCount = Math.max(0, Math.min(count, visibleColumnIndexes.value.length));
    frozenColumnCount.value = clampedCount;
    if (clampedCount > 0) {
      saveDataGridColumnFrozenCount(toValue(options.layoutScopeKey), clampedCount, columnOrderSnapshotBeforeFreeze.value);
    } else {
      removeDataGridColumnFrozenCount(toValue(options.layoutScopeKey));
    }
  }
  function freezeToColumn(visibleColIdx: number) {
    setFrozenColumnCount(visibleColIdx + 1);
  }
  function freezeSelectedColumns(selectedVisibleColIdxs: number[]) {
    if (selectedVisibleColIdxs.length === 0) return;
    const sorted = [...selectedVisibleColIdxs].sort((a, b) => a - b);
    const visibleIdxs = visibleColumnIndexes.value;
    // 获取选中列的 actualColIdx
    const selectedActualIdxs = sorted.map((vIdx) => visibleIdxs[vIdx]).filter((idx): idx is number => idx !== undefined);
    if (selectedActualIdxs.length === 0) return;
    const selectedSet = new Set(selectedActualIdxs);
    // 非选中列保持原序
    const currentOrder = orderedDisplayableColumnIndexes.value;
    const nonSelectedActualIdxs = currentOrder.filter((idx) => !selectedSet.has(idx));
    // 保存冻结前的列序快照（仅在首次冻结时保存，避免连续冻结覆盖快照）
    if (columnOrderSnapshotBeforeFreeze.value === null) {
      columnOrderSnapshotBeforeFreeze.value = [...persistedColumnOrderKeys.value];
    }
    // 新列序：选中列在前 + 非选中列在后
    persistColumnOrder([...selectedActualIdxs, ...nonSelectedActualIdxs]);
    setFrozenColumnCount(selectedActualIdxs.length);
  }
  function unfreezeAllColumns() {
    setFrozenColumnCount(0);
    // 还原冻结前的列序
    if (columnOrderSnapshotBeforeFreeze.value !== null) {
      const snapshot = columnOrderSnapshotBeforeFreeze.value;
      columnOrderSnapshotBeforeFreeze.value = null;
      if (snapshot.length === 0) {
        resetColumnOrder();
      } else {
        persistedColumnOrderKeys.value = snapshot;
        saveDataGridColumnOrder(toValue(options.layoutScopeKey), toValue(options.columnOrderKeys), snapshot);
        const tableScopeKey = toValue(options.tableScopeKey);
        if (tableScopeKey) {
          saveTableDataGridColumnOrder(tableScopeKey, snapshot);
          notifyTableDataGridColumnOrderChanged(tableScopeKey);
        }
      }
    }
  }
  function persistColumnOrder(indexes: number[]) {
    const tableScopeKey = toValue(options.tableScopeKey);
    if (isDefaultColumnOrder(toValue(options.displayableColumnIndexes), indexes)) {
      removeDataGridColumnOrder(toValue(options.layoutScopeKey));
      if (tableScopeKey) {
        removeTableDataGridColumnOrder(tableScopeKey);
        notifyTableDataGridColumnOrderChanged(tableScopeKey);
      }
      persistedColumnOrderKeys.value = [];
      return;
    }
    const keys = columnOrderKeysForIndexes(indexes, toValue(options.columnOrderKeys));
    persistedColumnOrderKeys.value = keys;
    saveDataGridColumnOrder(toValue(options.layoutScopeKey), toValue(options.columnOrderKeys), keys);
    if (tableScopeKey) {
      saveTableDataGridColumnOrder(tableScopeKey, keys);
      notifyTableDataGridColumnOrderChanged(tableScopeKey);
    }
  }
  function resetColumnOrder() {
    removeDataGridColumnOrder(toValue(options.layoutScopeKey));
    const tableScopeKey = toValue(options.tableScopeKey);
    if (tableScopeKey) {
      removeTableDataGridColumnOrder(tableScopeKey);
      notifyTableDataGridColumnOrderChanged(tableScopeKey);
    }
    persistedColumnOrderKeys.value = [];
    if (options.onRefreshMetrics) nextTick(options.onRefreshMetrics);
  }
  function setNullColumnsHidden(value: boolean) {
    if (options.hideNullColumns === undefined) localNullColumnsHidden.value = value;
    else options.onHideNullColumnsChange?.(value);
  }
  function applyNullColumnVisibility(hidden: boolean) {
    hiddenColumnIndexes.value = removeAutoHiddenColumnIndexes(hiddenColumnIndexes.value, autoHiddenNullColumnIndexes.value);
    autoHiddenNullColumnIndexes.value = new Set();
    if (!hidden) return;
    const next = hiddenColumnIndexesWithAllNullColumns({ availableIndexes: [...toValue(options.displayableColumnIndexes)], hiddenIndexes: hiddenColumnIndexes.value, allNullIndexes: new Set(toValue(options.allNullColumnIndexes)) });
    hiddenColumnIndexes.value = next.hiddenIndexes;
    autoHiddenNullColumnIndexes.value = next.autoHiddenIndexes;
  }
  function showAllNullColumns() {
    setNullColumnsHidden(false);
    applyNullColumnVisibility(false);
  }
  function hideAllNullColumns() {
    setNullColumnsHidden(true);
    applyNullColumnVisibility(true);
  }
  function toggleAllNullColumns() {
    if (nullColumnsHidden.value) showAllNullColumns();
    else hideAllNullColumns();
  }
  function onTableDataGridColumnOrderChanged(event: Event) {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as TableDataGridColumnOrderChangedDetail | undefined;
    if (!detail || detail.scopeKey !== toValue(options.tableScopeKey)) return;
    loadColumnOrder();
    if (options.onRefreshMetrics) nextTick(options.onRefreshMetrics);
  }

  function resetColumnVisibility() {
    hiddenColumnIndexes.value = new Set();
    autoHiddenNullColumnIndexes.value = new Set();
    applyNullColumnVisibility(nullColumnsHidden.value);
  }

  watch([() => nullColumnsHidden.value, () => [...toValue(options.allNullColumnIndexes)], () => [...toValue(options.displayableColumnIndexes)]], ([hidden]) => applyNullColumnVisibility(hidden as boolean), { immediate: true });
  watch(
    () => visibleColumnIndexes.value.length,
    (visibleCount) => {
      if (frozenColumnCount.value > visibleCount) setFrozenColumnCount(visibleCount);
    },
    { flush: "sync" },
  );
  watch(
    [() => toValue(options.layoutScopeKey), () => toValue(options.tableScopeKey)],
    () => {
      loadColumnOrder();
      loadFrozenColumnCount();
    },
    { immediate: true },
  );

  return {
    hiddenColumnIndexes,
    nullColumnsHidden,
    orderedDisplayableColumnIndexes,
    visibleColumnIndexes,
    displayableColumnCount,
    hiddenColumnCount,
    allNullColumnCount,
    hasCustomColumnOrder,
    canToggleAllNullColumns,
    filteredColumnVisibilityOptions,
    isColumnVisible,
    toggleColumnVisibility,
    showAllColumns,
    invertColumnVisibility,
    persistColumnOrder,
    resetColumnOrder,
    toggleAllNullColumns,
    resetColumnVisibility,
    onTableDataGridColumnOrderChanged,
    frozenColumnCount,
    freezeToColumn,
    freezeSelectedColumns,
    unfreezeAllColumns,
  };
}

export function useDataGridColumnLayout(options: {
  columnNames: MaybeRefOrGetter<readonly string[]>;
  visibleColumnIndexes: MaybeRefOrGetter<readonly number[]>;
  renderedColumnWidths: MaybeRefOrGetter<readonly number[]>;
  scrollLeft: MaybeRefOrGetter<number>;
  viewportWidth: MaybeRefOrGetter<number>;
  rowNumberWidth: number;
  bufferPx?: number;
  headerRef?: MaybeRefOrGetter<HTMLElement | null | undefined>;
  orderedColumnIndexes?: MaybeRefOrGetter<readonly number[]>;
  hiddenColumnIndexes?: MaybeRefOrGetter<ReadonlySet<number>>;
  getIsResizing?: () => boolean;
  onResizeStart?: (visibleColIdx: number, event: MouseEvent) => void;
  onCanvasMouseLeave?: () => void;
  onCanvasDrawSchedule?: () => void;
  onRefreshMetrics?: () => void;
  onPersistColumnOrder?: (indexes: number[]) => void;
  frozenColumnCount?: MaybeRefOrGetter<number>;
}) {
  const renderedColumnOffsets = computed(() => dataGridColumnOffsets(toValue(options.renderedColumnWidths)));
  const frozenColumnCount = computed(() => toValue(options.frozenColumnCount ?? 0));
  const horizontalColumnWindow = computed(() =>
    dataGridHorizontalColumnWindow({
      widths: toValue(options.renderedColumnWidths),
      offsets: renderedColumnOffsets.value,
      columnCount: toValue(options.visibleColumnIndexes).length,
      scrollLeft: toValue(options.scrollLeft),
      viewportWidth: toValue(options.viewportWidth),
      rowNumberWidth: options.rowNumberWidth,
      bufferPx: options.bufferPx ?? 900,
    }),
  );
  const renderedGridColumns = computed<RenderedDataGridColumn[]>(() => {
    const columnNames = toValue(options.columnNames);
    const visibleIndexes = toValue(options.visibleColumnIndexes);
    const window = horizontalColumnWindow.value;
    const frozen = frozenColumnCount.value;
    // 无冻结列时保持原始行为
    if (frozen === 0) {
      return visibleIndexes.slice(window.start, window.end).map((actualColIdx, offset) => ({
        visibleColIdx: window.start + offset,
        actualColIdx,
        name: columnNames[actualColIdx] ?? "",
      }));
    }
    const result: RenderedDataGridColumn[] = [];
    // 冻结列始终包含在渲染窗口中（0 ~ frozen-1）
    for (let i = 0; i < frozen && i < visibleIndexes.length; i++) {
      result.push({ visibleColIdx: i, actualColIdx: visibleIndexes[i], name: columnNames[visibleIndexes[i]] ?? "" });
    }
    // 非冻结列从 max(window.start, frozen) 到 window.end
    const nonFrozenStart = Math.max(window.start, frozen);
    for (let i = nonFrozenStart; i < window.end && i < visibleIndexes.length; i++) {
      result.push({ visibleColIdx: i, actualColIdx: visibleIndexes[i], name: columnNames[visibleIndexes[i]] ?? "" });
    }
    return result;
  });
  // 冻结列占位宽度：非冻结列的前置占位需要排除冻结列
  const frozenWidth = computed(() => renderedColumnOffsets.value[frozenColumnCount.value] ?? 0);
  const horizontalColumnWindowBeforeWidth = computed(() => {
    const window = horizontalColumnWindow.value;
    const frozen = frozenColumnCount.value;
    if (frozen === 0) return window.beforeWidth ?? 0;
    // 非冻结列从 max(window.start, frozen) 开始，前置占位 = 该列偏移 - 冻结列宽度
    const nonFrozenStart = Math.max(window.start, frozen);
    return Math.max(0, (renderedColumnOffsets.value[nonFrozenStart] ?? 0) - (renderedColumnOffsets.value[frozen] ?? 0));
  });

  function renderedColumnStyle(visibleColIdx: number) {
    const style: Record<string, string | number> = { width: `var(--col-w-${visibleColIdx})` };
    if (visibleColIdx < frozenColumnCount.value) {
      style.position = "sticky";
      style.left = `${columnContentOffsetLeft(visibleColIdx)}px`;
      style.zIndex = 10;
    }
    return style;
  }

  function columnContentOffsetLeft(visibleColIdx: number): number {
    return options.rowNumberWidth + (renderedColumnOffsets.value[visibleColIdx] ?? 0);
  }

  const columnHeaderDragState = ref<ColumnHeaderDragState | null>(null);
  const columnHeaderResizeActive = ref(false);
  let columnHeaderDragClickGuardUntil = 0;
  let columnHeaderSuppressNextClick = false;
  let columnHeaderSuppressClickTimer = 0;
  let columnHeaderDragFrame = 0;
  let columnHeaderResizeFrame = 0;
  let columnHeaderPendingClientX = 0;
  let columnHeaderResizeListenersCleanup: (() => void) | null = null;

  const columnHeaderTooltipsDisabled = computed(() =>
    columnHeaderTooltipDisabled({
      columnDragActive: columnHeaderDragState.value !== null,
      columnResizeActive: columnHeaderResizeActive.value,
    }),
  );

  function columnHeaderPointerInteractionActive(): boolean {
    return columnHeaderCanvasPointerDisabled({
      columnDragActive: columnHeaderDragState.value !== null,
      columnResizeActive: columnHeaderResizeActive.value,
    });
  }

  function clearColumnHeaderResizeListeners() {
    columnHeaderResizeListenersCleanup?.();
    columnHeaderResizeListenersCleanup = null;
  }

  function clearColumnHeaderClickGuard() {
    columnHeaderSuppressNextClick = false;
    columnHeaderDragClickGuardUntil = 0;
    if (columnHeaderSuppressClickTimer) {
      window.clearTimeout(columnHeaderSuppressClickTimer);
      columnHeaderSuppressClickTimer = 0;
    }
  }

  function armColumnHeaderClickGuard() {
    clearColumnHeaderClickGuard();
    columnHeaderSuppressNextClick = true;
    columnHeaderDragClickGuardUntil = Date.now() + 800;
    columnHeaderSuppressClickTimer = window.setTimeout(clearColumnHeaderClickGuard, 800);
  }

  function finishColumnHeaderResizeInteraction() {
    clearColumnHeaderResizeListeners();
    if (columnHeaderResizeFrame) cancelAnimationFrame(columnHeaderResizeFrame);
    columnHeaderResizeFrame = requestAnimationFrame(() => {
      columnHeaderResizeFrame = 0;
      columnHeaderResizeActive.value = false;
    });
  }

  function startColumnHeaderResize(visibleColIdx: number, event: MouseEvent) {
    clearColumnHeaderResizeListeners();
    if (columnHeaderResizeFrame) {
      cancelAnimationFrame(columnHeaderResizeFrame);
      columnHeaderResizeFrame = 0;
    }
    columnHeaderResizeActive.value = true;
    armColumnHeaderClickGuard();
    options.onCanvasMouseLeave?.();
    const finishResize = () => {
      armColumnHeaderClickGuard();
      finishColumnHeaderResizeInteraction();
    };
    columnHeaderResizeListenersCleanup = () => {
      window.removeEventListener("mouseup", finishResize, true);
      window.removeEventListener("blur", finishResize, true);
    };
    window.addEventListener("mouseup", finishResize, true);
    window.addEventListener("blur", finishResize, true);
    options.onResizeStart?.(visibleColIdx, event);
  }

  function columnHeaderInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && !!target.closest("button, input, textarea, select, [contenteditable='true'], [role='button'], [data-column-resize-handle]");
  }

  function columnHeaderDropTargetVisibleIndex(clientX: number): number {
    const state = columnHeaderDragState.value;
    if (!state || state.columnRects.length === 0) return state?.sourceVisibleIndex ?? 0;
    for (const rect of state.columnRects) {
      if (clientX < rect.left + rect.width / 2) return rect.visibleIndex;
    }
    return toValue(options.visibleColumnIndexes).length;
  }

  function applyColumnHeaderDragPreview() {
    columnHeaderDragFrame = 0;
    const state = columnHeaderDragState.value;
    if (!state?.dragging) return;
    state.currentX = columnHeaderPendingClientX;
    state.targetVisibleIndex = columnHeaderDropTargetVisibleIndex(columnHeaderPendingClientX);
    options.onCanvasDrawSchedule?.();
  }

  function scheduleColumnHeaderDragPreview(clientX: number) {
    columnHeaderPendingClientX = clientX;
    if (columnHeaderDragFrame) return;
    columnHeaderDragFrame = requestAnimationFrame(applyColumnHeaderDragPreview);
  }

  function flushColumnHeaderDragPreview() {
    if (columnHeaderDragFrame) cancelAnimationFrame(columnHeaderDragFrame);
    applyColumnHeaderDragPreview();
  }

  function cancelColumnHeaderDragPreview() {
    if (!columnHeaderDragFrame) return;
    cancelAnimationFrame(columnHeaderDragFrame);
    columnHeaderDragFrame = 0;
  }

  function columnHeaderLayoutRects() {
    const header = toValue(options.headerRef);
    return Array.from(header?.querySelectorAll<HTMLElement>("[data-visible-col-index]") ?? [])
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { visibleIndex: Number(element.dataset.visibleColIndex), left: rect.left, width: rect.width };
      })
      .filter((rect) => Number.isFinite(rect.visibleIndex));
  }

  function stopColumnHeaderDrag(commit: boolean) {
    const state = columnHeaderDragState.value;
    if (!state) return;
    const hadCanvasPreview = state.dragging;
    window.removeEventListener("pointermove", onColumnHeaderPointerMove, true);
    window.removeEventListener("pointerup", onColumnHeaderPointerUp, true);
    window.removeEventListener("pointercancel", onColumnHeaderPointerCancel, true);
    cancelColumnHeaderDragPreview();
    document.body.style.userSelect = "";
    columnHeaderDragState.value = null;
    if (hadCanvasPreview) options.onCanvasDrawSchedule?.();
    if (state.dragging) armColumnHeaderClickGuard();
    if (!commit || !state.dragging || state.sourceVisibleIndex === state.targetVisibleIndex) return;
    const next = moveVisibleColumnIndex({
      orderedIndexes: toValue(options.orderedColumnIndexes ?? options.visibleColumnIndexes),
      hiddenIndexes: toValue(options.hiddenColumnIndexes ?? (() => new Set<number>())),
      fromVisibleIndex: state.sourceVisibleIndex,
      toVisibleIndex: state.targetVisibleIndex,
    });
    options.onPersistColumnOrder?.(next);
    options.onRefreshMetrics?.();
  }

  function onColumnHeaderPointerMove(event: PointerEvent) {
    const state = columnHeaderDragState.value;
    if (!state) return;
    const moved = Math.abs(event.clientX - state.startX) > 5 || Math.abs(event.clientY - state.startY) > 5;
    if (!state.dragging && moved) {
      state.dragging = true;
      document.body.style.userSelect = "none";
      options.onCanvasMouseLeave?.();
    }
    if (!state.dragging) return;
    event.preventDefault();
    scheduleColumnHeaderDragPreview(event.clientX);
  }

  function onColumnHeaderPointerUp(event: PointerEvent) {
    columnHeaderPendingClientX = event.clientX;
    flushColumnHeaderDragPreview();
    stopColumnHeaderDrag(true);
  }

  function onColumnHeaderPointerCancel() {
    stopColumnHeaderDrag(false);
  }

  function startColumnHeaderDrag(visibleColIdx: number, event: PointerEvent) {
    if (event.button !== 0 || options.getIsResizing?.() || columnHeaderInteractiveTarget(event.target)) return;
    columnHeaderDragState.value = {
      sourceVisibleIndex: visibleColIdx,
      targetVisibleIndex: visibleColIdx,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      columnRects: columnHeaderLayoutRects(),
      dragging: false,
    };
    columnHeaderPendingClientX = event.clientX;
    window.addEventListener("pointermove", onColumnHeaderPointerMove, true);
    window.addEventListener("pointerup", onColumnHeaderPointerUp, true);
    window.addEventListener("pointercancel", onColumnHeaderPointerCancel, true);
  }

  function suppressHeaderClickIfNeeded(event: MouseEvent): boolean {
    if (!columnHeaderClickShouldBeSuppressed({ now: Date.now(), guardUntil: columnHeaderDragClickGuardUntil, suppressNextClick: columnHeaderSuppressNextClick })) return false;
    clearColumnHeaderClickGuard();
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return true;
  }

  function columnHeaderDragClass(visibleColIdx: number) {
    const state = columnHeaderDragState.value;
    return { "z-30 shadow-lg ring-1 ring-primary/40 bg-background dark:bg-muted pointer-events-none": state?.dragging && state.sourceVisibleIndex === visibleColIdx };
  }

  function columnHeaderPreviewOffset(visibleColIdx: number): number {
    const state = columnHeaderDragState.value;
    if (!state) return 0;
    return columnHeaderPreviewOffsetForColumn({
      columnDragActive: state.dragging,
      visibleColIdx,
      sourceVisibleIndex: state.sourceVisibleIndex,
      targetVisibleIndex: state.targetVisibleIndex,
      startX: state.startX,
      currentX: state.currentX,
      sourceWidth: toValue(options.renderedColumnWidths)[state.sourceVisibleIndex] ?? 0,
    });
  }

  function columnHeaderStyle(visibleColIdx: number) {
    const style = renderedColumnStyle(visibleColIdx);
    const offset = columnHeaderPreviewOffset(visibleColIdx);
    // 冻结列头需要更高 z-index（与列头行号 z-20 一致）以覆盖非冻结列头
    if (visibleColIdx < frozenColumnCount.value) {
      (style as Record<string, string | number>).zIndex = 20;
    }
    if (!offset) return style;
    return { ...style, transform: `translateX(${offset}px)`, transition: columnHeaderDragState.value?.sourceVisibleIndex === visibleColIdx ? undefined : "transform 120ms ease-out" };
  }

  const columnHeaderPreviewOffsets = computed(() => toValue(options.renderedColumnWidths).map((_, visibleColIdx) => columnHeaderPreviewOffset(visibleColIdx)));
  const columnHeaderPreviewSourceVisibleIndex = computed(() => {
    const state = columnHeaderDragState.value;
    return state?.dragging ? state.sourceVisibleIndex : null;
  });

  function disposeColumnHeaderInteractions() {
    stopColumnHeaderDrag(false);
    clearColumnHeaderResizeListeners();
    clearColumnHeaderClickGuard();
    if (columnHeaderDragFrame) cancelAnimationFrame(columnHeaderDragFrame);
    if (columnHeaderResizeFrame) cancelAnimationFrame(columnHeaderResizeFrame);
    columnHeaderResizeFrame = 0;
    document.body.style.userSelect = "";
  }
  onScopeDispose(disposeColumnHeaderInteractions);

  return {
    renderedColumnOffsets,
    horizontalColumnWindow,
    renderedGridColumns,
    renderedColumnStyle,
    columnContentOffsetLeft,
    frozenWidth,
    horizontalColumnWindowBeforeWidth,
    columnHeaderDragState,
    columnHeaderResizeActive,
    columnHeaderTooltipsDisabled,
    columnHeaderPreviewOffsets,
    columnHeaderPreviewSourceVisibleIndex,
    columnHeaderPointerInteractionActive,
    startColumnHeaderResize,
    startColumnHeaderDrag,
    suppressHeaderClickIfNeeded,
    columnHeaderDragClass,
    columnHeaderStyle,
    disposeColumnHeaderInteractions,
  };
}
