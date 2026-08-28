import { computed, nextTick, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { columnOrderKeysForIndexes, isDefaultColumnOrder, mergeUnavailableColumnOrderKeys, moveDisplayableColumnIndex, moveVisibleColumnIndex, orderedColumnIndexes } from "@/lib/dataGrid/dataGridColumnOrder";
import { columnHeaderCanvasPointerDisabled, columnHeaderClickShouldBeSuppressed, columnHeaderDragAutoScrollDelta, columnHeaderDropTargetIndex, columnHeaderPreviewOffsetForColumn, columnHeaderTooltipDisabled } from "@/lib/dataGrid/dataGridColumnHeaderInteraction";
import {
  loadDataGridColumnLayout,
  loadDataGridColumnFrozenState,
  loadTableDataGridColumnOrder,
  notifyTableDataGridColumnOrderChanged,
  removeDataGridColumnFrozenCount,
  removeTableDataGridColumnOrder,
  saveDataGridColumnLayout,
  saveDataGridColumnFrozenCount,
  saveTableDataGridColumnOrder,
  type TableDataGridColumnOrderChangedDetail,
} from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import { buildDataGridColumnLookupItems, filterDataGridColumnLookupItems, type DataGridColumnLookupItem } from "@/lib/dataGrid/dataGridColumnLookup";
import { hiddenColumnIndexesForKeys, hiddenColumnIndexesWithAllNullColumns, hiddenColumnKeysForIndexes, invertedHiddenColumnIndexes, nextHiddenColumnIndexes, removeAutoHiddenColumnIndexes, visibleColumnIndexesForFilter } from "@/lib/dataGrid/dataGridColumnVisibility";

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

export interface DataGridColumnLayoutOption extends DataGridColumnLookupItem {
  key: string;
  column: string;
  visible: boolean;
  displayPosition: number;
}

type ColumnHeaderDragState = {
  sourceVisibleIndex: number;
  targetVisibleIndex: number;
  startX: number;
  startY: number;
  currentX: number;
  startScrollLeft: number;
  currentScrollLeft: number;
  dragCenterClientOffsetX: number;
  lastClientX: number;
  direction: -1 | 0 | 1;
  columnRects: { visibleIndex: number; left: number; width: number }[];
  previewElement: HTMLElement | null;
  dragging: boolean;
  /** 指针进入 SQL 编辑器后切换为“插入列引用”模式，重排序预览挂起。 */
  referenceMode: boolean;
  /** 本次手势中 onEnter 已拒绝过该列（不可作为引用），不再重复试探。 */
  referenceUnavailable: boolean;
};

/**
 * 目标导向拖拽控制器：网格内保持列重排序手势；指针进入 SQL 编辑器区域时
 * 由 DataGrid 提供的实现接管反馈与最终插入。
 */
export interface ColumnHeaderReferenceDragController {
  isOverEditorTarget(clientX: number, clientY: number): boolean;
  /** 进入编辑器目标时回调；返回 chip 文案，null 表示该列不可作为引用拖入。 */
  onEnter(sourceVisibleIndex: number): string | null;
  onMove(sourceVisibleIndex: number, clientX: number, clientY: number): void;
  /** 在编辑器目标内释放时回调；返回 true 表示已处理插入。 */
  onDrop(sourceVisibleIndex: number, clientX: number, clientY: number): boolean;
  /** 引用模式结束（无论是否发生插入）时清理反馈。 */
  onCancel(): void;
}

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
  columnComments?: MaybeRefOrGetter<readonly (string | undefined)[] | undefined>;
  commentByColumn?: MaybeRefOrGetter<ReadonlyMap<string, string>>;
  displayableColumnIndexes: MaybeRefOrGetter<readonly number[]>;
  allNullColumnIndexes: MaybeRefOrGetter<readonly number[]>;
  columnOrderKeys: MaybeRefOrGetter<readonly string[]>;
  layoutScopeKey: MaybeRefOrGetter<string>;
  tableScopeKey: MaybeRefOrGetter<string>;
  initialHiddenColumnKeys?: MaybeRefOrGetter<readonly string[] | undefined>;
  hideNullColumns?: MaybeRefOrGetter<boolean>;
  onHideNullColumnsChange?: (value: boolean) => void;
  onRefreshMetrics?: () => void;
}) {
  const hiddenColumnIndexes = ref<Set<number>>(hiddenColumnIndexesForKeys(toValue(options.initialHiddenColumnKeys), toValue(options.columnOrderKeys), toValue(options.displayableColumnIndexes)));
  const localNullColumnsHidden = ref(false);
  const nullColumnsHidden = computed(() => (options.hideNullColumns === undefined ? localNullColumnsHidden.value : toValue(options.hideNullColumns)));
  const autoHiddenNullColumnIndexes = ref<Set<number>>(new Set());
  const persistedColumnOrderKeys = ref<string[]>([]);
  const persistedHiddenColumnKeys = ref<string[]>([...(toValue(options.initialHiddenColumnKeys) ?? [])]);
  const frozenColumnCount = ref(0);
  const columnOrderSnapshotBeforeFreeze = ref<string[] | null>(null);
  let columnLayoutPersistTimer: ReturnType<typeof setTimeout> | undefined;
  let columnLayoutPersistPending = false;
  let pendingColumnLayoutScopeKey = "";
  const orderedDisplayableColumnIndexes = computed(() => orderedColumnIndexes({ availableIndexes: toValue(options.displayableColumnIndexes), columnKeys: toValue(options.columnOrderKeys), orderedKeys: persistedColumnOrderKeys.value }));
  const visibleColumnIndexes = computed(() => visibleColumnIndexesForFilter(orderedDisplayableColumnIndexes.value, hiddenColumnIndexes.value));
  const displayableColumnCount = computed(() => toValue(options.displayableColumnIndexes).length);
  const hiddenColumnCount = computed(() => displayableColumnCount.value - visibleColumnIndexes.value.length);
  const allNullColumnCount = computed(() => toValue(options.allNullColumnIndexes).length);
  const hasCustomColumnOrder = computed(() => !isDefaultColumnOrder(toValue(options.displayableColumnIndexes), orderedDisplayableColumnIndexes.value));
  const canToggleAllNullColumns = computed(() => nullColumnsHidden.value || (toValue(options.allNullColumnIndexes).length > 0 && displayableColumnCount.value > 1));
  const columnLookupItems = computed(() =>
    buildDataGridColumnLookupItems({
      columns: toValue(options.columns),
      sourceColumns: toValue(options.sourceColumns),
      columnComments: toValue(options.columnComments),
      displayableIndexes: toValue(options.displayableColumnIndexes),
      commentByColumn: toValue(options.commentByColumn),
    }),
  );
  const columnLookupItemByIndex = computed(() => new Map(columnLookupItems.value.map((item) => [item.index, item])));
  const orderedColumnLayoutOptions = computed<DataGridColumnLayoutOption[]>(() =>
    orderedDisplayableColumnIndexes.value.flatMap((columnIndex, displayPosition) => {
      const item = columnLookupItemByIndex.value.get(columnIndex);
      const key = toValue(options.columnOrderKeys)[columnIndex];
      if (!item || !key) return [];
      return [
        {
          ...item,
          key,
          column: item.name,
          visible: !hiddenColumnIndexes.value.has(columnIndex),
          displayPosition,
        },
      ];
    }),
  );

  function filteredColumnLayoutOptions(query: string): DataGridColumnLayoutOption[] {
    return filterDataGridColumnLookupItems(orderedColumnLayoutOptions.value, query);
  }
  function isColumnVisible(columnIndex: number) {
    return !hiddenColumnIndexes.value.has(columnIndex);
  }

  function flushPersistColumnLayout() {
    if (!columnLayoutPersistPending) return;
    if (columnLayoutPersistTimer !== undefined) clearTimeout(columnLayoutPersistTimer);
    columnLayoutPersistTimer = undefined;
    columnLayoutPersistPending = false;
    saveDataGridColumnLayout(pendingColumnLayoutScopeKey || toValue(options.layoutScopeKey), {
      orderKeys: persistedColumnOrderKeys.value,
      hiddenKeys: persistedHiddenColumnKeys.value,
    });
  }

  function markColumnLayoutForPersistence() {
    columnLayoutPersistPending = true;
    pendingColumnLayoutScopeKey = toValue(options.layoutScopeKey);
  }

  function schedulePersistColumnLayout() {
    markColumnLayoutForPersistence();
    if (columnLayoutPersistTimer !== undefined) clearTimeout(columnLayoutPersistTimer);
    columnLayoutPersistTimer = setTimeout(flushPersistColumnLayout, 100);
  }

  function persistColumnLayoutImmediately() {
    markColumnLayoutForPersistence();
    flushPersistColumnLayout();
  }

  function currentManualHiddenColumnKeys() {
    return hiddenColumnKeysForIndexes(hiddenColumnIndexes.value, autoHiddenNullColumnIndexes.value, toValue(options.columnOrderKeys), toValue(options.displayableColumnIndexes));
  }

  function persistHiddenColumnKeys() {
    const currentKeys = new Set(toValue(options.displayableColumnIndexes).flatMap((index) => toValue(options.columnOrderKeys)[index] ?? []));
    const unavailableHiddenKeys = persistedHiddenColumnKeys.value.filter((key) => !currentKeys.has(key));
    persistedHiddenColumnKeys.value = [...new Set([...unavailableHiddenKeys, ...currentManualHiddenColumnKeys()])];
    schedulePersistColumnLayout();
  }

  function toggleColumnVisibility(columnIndex: number) {
    hiddenColumnIndexes.value = nextHiddenColumnIndexes({ columnIndex, hiddenIndexes: hiddenColumnIndexes.value, totalColumns: displayableColumnCount.value });
    if (!hiddenColumnIndexes.value.has(columnIndex) && autoHiddenNullColumnIndexes.value.delete(columnIndex)) {
      autoHiddenNullColumnIndexes.value = new Set(autoHiddenNullColumnIndexes.value);
    }
    persistHiddenColumnKeys();
  }

  function showAllColumns() {
    hiddenColumnIndexes.value = new Set();
    autoHiddenNullColumnIndexes.value = new Set();
    persistedHiddenColumnKeys.value = [];
    schedulePersistColumnLayout();
  }

  function invertColumnVisibility() {
    hiddenColumnIndexes.value = invertedHiddenColumnIndexes([...toValue(options.displayableColumnIndexes)], hiddenColumnIndexes.value);
    autoHiddenNullColumnIndexes.value = new Set();
    persistHiddenColumnKeys();
  }

  function showColumn(columnIndex: number) {
    if (!hiddenColumnIndexes.value.has(columnIndex)) return;
    hiddenColumnIndexes.value.delete(columnIndex);
    hiddenColumnIndexes.value = new Set(hiddenColumnIndexes.value);
    autoHiddenNullColumnIndexes.value.delete(columnIndex);
    autoHiddenNullColumnIndexes.value = new Set(autoHiddenNullColumnIndexes.value);
    persistHiddenColumnKeys();
  }

  function loadColumnLayout() {
    flushPersistColumnLayout();
    const storedLayout = loadDataGridColumnLayout(toValue(options.layoutScopeKey), toValue(options.columnOrderKeys));
    const tableScopeKey = toValue(options.tableScopeKey);
    const tableOrder = tableScopeKey ? loadTableDataGridColumnOrder(tableScopeKey) : [];
    persistedColumnOrderKeys.value = tableOrder.length ? tableOrder : (storedLayout?.orderKeys ?? []);
    persistedHiddenColumnKeys.value = storedLayout?.hiddenKeys ?? [...(toValue(options.initialHiddenColumnKeys) ?? [])];
    resetColumnVisibility();
    if (!storedLayout && persistedHiddenColumnKeys.value.length > 0) schedulePersistColumnLayout();
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
    const selectedActualIdxs = sorted.map((vIdx) => visibleIdxs[vIdx]).filter((idx): idx is number => idx !== undefined);
    if (selectedActualIdxs.length === 0) return;
    const selectedSet = new Set(selectedActualIdxs);
    const currentOrder = orderedDisplayableColumnIndexes.value;
    const nonSelectedActualIdxs = currentOrder.filter((idx) => !selectedSet.has(idx));
    // 首次冻结时保留原序，连续冻结不能覆盖用户真正的起始顺序。
    if (columnOrderSnapshotBeforeFreeze.value === null) {
      columnOrderSnapshotBeforeFreeze.value = [...persistedColumnOrderKeys.value];
    }
    persistColumnOrder([...selectedActualIdxs, ...nonSelectedActualIdxs]);
    setFrozenColumnCount(selectedActualIdxs.length);
  }

  function unfreezeAllColumns() {
    setFrozenColumnCount(0);
    if (columnOrderSnapshotBeforeFreeze.value !== null) {
      const snapshot = columnOrderSnapshotBeforeFreeze.value;
      columnOrderSnapshotBeforeFreeze.value = null;
      if (snapshot.length === 0) {
        resetColumnOrder();
      } else {
        persistedColumnOrderKeys.value = snapshot;
        persistColumnLayoutImmediately();
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
      persistedColumnOrderKeys.value = [];
      persistColumnLayoutImmediately();
      if (tableScopeKey) {
        removeTableDataGridColumnOrder(tableScopeKey);
        notifyTableDataGridColumnOrderChanged(tableScopeKey);
      }
      return;
    }
    const currentKeys = columnOrderKeysForIndexes(indexes, toValue(options.columnOrderKeys));
    const keys = mergeUnavailableColumnOrderKeys(currentKeys, persistedColumnOrderKeys.value);
    persistedColumnOrderKeys.value = keys;
    persistColumnLayoutImmediately();
    if (tableScopeKey) {
      saveTableDataGridColumnOrder(tableScopeKey, keys);
      notifyTableDataGridColumnOrderChanged(tableScopeKey);
    }
  }

  function moveDisplayableColumn(fromDisplayableIndex: number, toDisplayableIndex: number) {
    const next = moveDisplayableColumnIndex({
      orderedIndexes: orderedDisplayableColumnIndexes.value,
      fromDisplayableIndex,
      toDisplayableIndex,
    });
    persistColumnOrder(next);
  }

  function resetColumnOrder() {
    persistedColumnOrderKeys.value = [];
    persistColumnLayoutImmediately();
    const tableScopeKey = toValue(options.tableScopeKey);
    if (tableScopeKey) {
      removeTableDataGridColumnOrder(tableScopeKey);
      notifyTableDataGridColumnOrderChanged(tableScopeKey);
    }
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
    persistedColumnOrderKeys.value = loadTableDataGridColumnOrder(detail.scopeKey);
    if (options.onRefreshMetrics) nextTick(options.onRefreshMetrics);
  }

  function resetColumnVisibility(hiddenColumnKeys: readonly string[] = persistedHiddenColumnKeys.value) {
    hiddenColumnIndexes.value = hiddenColumnIndexesForKeys(hiddenColumnKeys, toValue(options.columnOrderKeys), toValue(options.displayableColumnIndexes));
    autoHiddenNullColumnIndexes.value = new Set();
    applyNullColumnVisibility(nullColumnsHidden.value);
  }

  onScopeDispose(flushPersistColumnLayout);
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
      loadColumnLayout();
      loadFrozenColumnCount();
    },
    { immediate: true },
  );
  watch([() => [...toValue(options.columnOrderKeys)], () => [...toValue(options.displayableColumnIndexes)]], () => resetColumnVisibility(), { flush: "sync" });

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
    orderedColumnLayoutOptions,
    filteredColumnLayoutOptions,
    isColumnVisible,
    toggleColumnVisibility,
    showAllColumns,
    invertColumnVisibility,
    showColumn,
    persistColumnOrder,
    moveDisplayableColumn,
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
  rowNumberWidth: MaybeRefOrGetter<number>;
  bufferPx?: number;
  headerRef?: MaybeRefOrGetter<HTMLElement | null | undefined>;
  getScrollElement?: () => HTMLElement | null;
  orderedColumnIndexes?: MaybeRefOrGetter<readonly number[]>;
  hiddenColumnIndexes?: MaybeRefOrGetter<ReadonlySet<number>>;
  getIsResizing?: () => boolean;
  onResizeStart?: (visibleColIdx: number, event: MouseEvent) => void;
  onCanvasMouseLeave?: () => void;
  onCanvasDrawSchedule?: () => void;
  onHorizontalScroll?: (element: HTMLElement) => void;
  onRefreshMetrics?: () => void;
  onPersistColumnOrder?: (indexes: number[]) => void;
  frozenColumnCount?: MaybeRefOrGetter<number>;
  columnReferenceDrag?: ColumnHeaderReferenceDragController;
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
      rowNumberWidth: toValue(options.rowNumberWidth),
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
    return toValue(options.rowNumberWidth) + (renderedColumnOffsets.value[visibleColIdx] ?? 0);
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

  function columnHeaderPointerContentX(clientX: number, scroller?: HTMLElement | null): number {
    if (!scroller) return clientX;
    const viewport = scroller.getBoundingClientRect();
    const frozen = frozenColumnCount.value;
    const pointerViewportX = clientX - viewport.left;
    const frozenRight = toValue(options.rowNumberWidth) + (renderedColumnOffsets.value[frozen] ?? 0);
    return frozen > 0 && pointerViewportX < frozenRight ? pointerViewportX - toValue(options.rowNumberWidth) : scroller.scrollLeft + pointerViewportX - toValue(options.rowNumberWidth);
  }

  function columnHeaderDropTargetVisibleIndex(clientX: number, scroller = options.getScrollElement?.()): number {
    const state = columnHeaderDragState.value;
    if (!state) return 0;
    const visibleColumnCount = toValue(options.visibleColumnIndexes).length;
    const movement = clientX - state.lastClientX;
    if (Math.abs(movement) >= 0.5) state.direction = movement < 0 ? -1 : 1;
    state.lastClientX = clientX;
    const dragCenterClientX = clientX + state.dragCenterClientOffsetX;
    const dragCenterContentX = columnHeaderPointerContentX(dragCenterClientX, scroller);
    if (scroller) {
      const viewport = scroller.getBoundingClientRect();
      const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      if (state.direction < 0 && scroller.scrollLeft <= 0 && clientX <= viewport.left + 64) return 0;
      if (state.direction > 0 && scroller.scrollLeft >= maxScrollLeft - 0.5 && clientX >= viewport.right - 64) return Math.max(0, visibleColumnCount - 1);

      const widths = toValue(options.renderedColumnWidths);
      return columnHeaderDropTargetIndex({ pointerContentX: dragCenterContentX, sourceVisibleIndex: state.sourceVisibleIndex, currentTargetIndex: state.targetVisibleIndex, direction: state.direction, columnWidths: widths, columnOffsets: renderedColumnOffsets.value });
    }
    if (state.columnRects.length === 0) return state.sourceVisibleIndex;
    const widths = state.columnRects.map((rect) => rect.width);
    const offsets = state.columnRects.map((rect) => rect.left);
    return Math.min(Math.max(0, visibleColumnCount - 1), columnHeaderDropTargetIndex({ pointerContentX: dragCenterContentX, sourceVisibleIndex: state.sourceVisibleIndex, currentTargetIndex: state.targetVisibleIndex, direction: state.direction, columnWidths: widths, columnOffsets: offsets }));
  }

  function createColumnHeaderDragPreview(state: ColumnHeaderDragState) {
    if (state.previewElement) return;
    const header = toValue(options.headerRef);
    const source = header?.querySelector<HTMLElement>(`[data-visible-col-index="${state.sourceVisibleIndex}"]`);
    if (!source) return;
    const rect = source.getBoundingClientRect();
    const preview = source.cloneNode(true) as HTMLElement;
    preview.dataset.columnHeaderDragPreview = "";
    preview.removeAttribute("data-visible-col-index");
    preview.setAttribute("aria-hidden", "true");
    preview.inert = true;
    Object.assign(preview.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      transform: "translateX(0)",
      transition: "none",
      zIndex: "100",
      pointerEvents: "none",
    });
    preview.classList.add("shadow-lg", "ring-1", "ring-primary/40");
    document.body.append(preview);
    state.previewElement = preview;
  }

  function updateColumnHeaderDragPreview(state: ColumnHeaderDragState) {
    if (!state.previewElement) return;
    state.previewElement.style.transform = `translateX(${state.currentX - state.startX}px)`;
  }

  function removeColumnHeaderDragPreview(state: ColumnHeaderDragState) {
    state.previewElement?.remove();
    state.previewElement = null;
  }

  function applyColumnHeaderDragPreview() {
    columnHeaderDragFrame = 0;
    const state = columnHeaderDragState.value;
    if (!state?.dragging) return;
    state.currentX = columnHeaderPendingClientX;
    updateColumnHeaderDragPreview(state);
    const scroller = options.getScrollElement?.();
    if (scroller) state.currentScrollLeft = scroller.scrollLeft;
    state.targetVisibleIndex = columnHeaderDropTargetVisibleIndex(columnHeaderPendingClientX, scroller);
    let keepScrolling = false;
    if (scroller) {
      const viewport = scroller.getBoundingClientRect();
      const frozenWidth = renderedColumnOffsets.value[frozenColumnCount.value] ?? 0;
      const scrollViewportLeft = Math.min(viewport.right, viewport.left + toValue(options.rowNumberWidth) + frozenWidth);
      const scrollDelta = columnHeaderDragAutoScrollDelta({ clientX: columnHeaderPendingClientX, viewportLeft: scrollViewportLeft, viewportRight: viewport.right });
      const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, scroller.scrollLeft + scrollDelta));
      if (Math.abs(nextScrollLeft - scroller.scrollLeft) >= 0.5) {
        scroller.scrollLeft = nextScrollLeft;
        state.currentScrollLeft = scroller.scrollLeft;
        options.onHorizontalScroll?.(scroller);
        state.targetVisibleIndex = columnHeaderDropTargetVisibleIndex(columnHeaderPendingClientX, scroller);
        keepScrolling = true;
      }
    }
    options.onCanvasDrawSchedule?.();
    if (keepScrolling) columnHeaderDragFrame = requestAnimationFrame(applyColumnHeaderDragPreview);
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
    window.removeEventListener("blur", onColumnHeaderPointerCancel, true);
    document.removeEventListener("selectstart", blockColumnHeaderNativeInteraction, true);
    document.removeEventListener("dragstart", blockColumnHeaderNativeInteraction, true);
    cancelColumnHeaderDragPreview();
    removeColumnHeaderDragPreview(state);
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

  function enterColumnReferenceMode(state: ColumnHeaderDragState, clientX: number, clientY: number): boolean {
    const controller = options.columnReferenceDrag;
    if (!controller) return false;
    const label = controller.onEnter(state.sourceVisibleIndex);
    if (label == null) return false;
    state.referenceMode = true;
    cancelColumnHeaderDragPreview();
    removeColumnHeaderDragPreview(state);
    controller.onMove(state.sourceVisibleIndex, clientX, clientY);
    return true;
  }

  function exitColumnReferenceMode(state: ColumnHeaderDragState) {
    const controller = options.columnReferenceDrag;
    state.referenceMode = false;
    state.referenceUnavailable = false;
    if (state.dragging) createColumnHeaderDragPreview(state);
    controller?.onCancel();
  }

  /** 指针是否仍在本网格区域内（滚动区或表头行），用于“拖出网格释放=取消”。 */
  function pointerInsideGridArea(clientX: number, clientY: number): boolean {
    const rects: DOMRect[] = [];
    const scroller = options.getScrollElement?.();
    if (scroller) rects.push(scroller.getBoundingClientRect());
    const header = toValue(options.headerRef);
    if (header) rects.push(header.getBoundingClientRect());
    return rects.some((rect) => clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
  }

  function onColumnHeaderPointerMove(event: PointerEvent) {
    const state = columnHeaderDragState.value;
    if (!state) return;
    const moved = Math.abs(event.clientX - state.startX) > 5 || Math.abs(event.clientY - state.startY) > 5;
    if (!state.dragging && moved) {
      state.dragging = true;
      document.body.style.userSelect = "none";
      options.onCanvasMouseLeave?.();
      createColumnHeaderDragPreview(state);
    }
    if (!state.dragging) return;
    const controller = options.columnReferenceDrag;
    if (controller && !state.referenceUnavailable) {
      const overEditor = controller.isOverEditorTarget(event.clientX, event.clientY);
      if (overEditor && !state.referenceMode) {
        // 进入编辑器：尝试切换为列引用模式；不可引用（onEnter 返回 null）时保持重排序并不再试探。
        if (enterColumnReferenceMode(state, event.clientX, event.clientY)) return;
        state.referenceUnavailable = true;
      } else if (!overEditor && state.referenceMode) {
        exitColumnReferenceMode(state);
      }
    }
    if (state.referenceMode) {
      event.preventDefault();
      controller?.onMove(state.sourceVisibleIndex, event.clientX, event.clientY);
      return;
    }
    event.preventDefault();
    scheduleColumnHeaderDragPreview(event.clientX);
  }

  function onColumnHeaderPointerUp(event: PointerEvent) {
    const state = columnHeaderDragState.value;
    if (state?.referenceMode) {
      const controller = options.columnReferenceDrag!;
      if (controller.isOverEditorTarget(event.clientX, event.clientY)) {
        // 在编辑器内释放：插入列引用（onDrop 失败也只按取消收尾）。
        controller.onDrop(state.sourceVisibleIndex, event.clientX, event.clientY);
      }
      controller.onCancel();
      stopColumnHeaderDrag(false);
      return;
    }
    columnHeaderPendingClientX = event.clientX;
    flushColumnHeaderDragPreview();
    // 目标导向手势启用时，把列拖出网格与编辑器之外释放=取消，不重排列。
    if (state?.dragging && options.columnReferenceDrag && !options.columnReferenceDrag.isOverEditorTarget(event.clientX, event.clientY) && !pointerInsideGridArea(event.clientX, event.clientY)) {
      stopColumnHeaderDrag(false);
      return;
    }
    stopColumnHeaderDrag(true);
  }

  function onColumnHeaderPointerCancel() {
    const state = columnHeaderDragState.value;
    if (state?.referenceMode) options.columnReferenceDrag?.onCancel();
    stopColumnHeaderDrag(false);
  }

  /** 拖拽期间拦截原生文本选择与 HTML5 拖拽启动，防止其抢占指针事件流。 */
  function blockColumnHeaderNativeInteraction(event: Event) {
    event.preventDefault();
  }

  function startColumnHeaderDrag(visibleColIdx: number, event: PointerEvent) {
    if (event.button !== 0 || options.getIsResizing?.() || columnHeaderInteractiveTarget(event.target)) return;
    const scroller = options.getScrollElement?.();
    const scrollLeft = scroller?.scrollLeft ?? 0;
    const columnRects = columnHeaderLayoutRects();
    const sourceRect = columnRects.find((rect) => rect.visibleIndex === visibleColIdx);
    const dragCenterClientOffsetX = sourceRect ? sourceRect.left + sourceRect.width / 2 - event.clientX : 0;
    // 阻止原生文本选择/HTML5 拖拽抢占事件流：一旦发生会派发 pointercancel 并停发 pointermove，
    // 手势将被冻结（表现为拖不动）。参照侧边栏表引用路径在起点即禁用。
    event.preventDefault();
    document.addEventListener("selectstart", blockColumnHeaderNativeInteraction, true);
    document.addEventListener("dragstart", blockColumnHeaderNativeInteraction, true);
    columnHeaderDragState.value = {
      sourceVisibleIndex: visibleColIdx,
      targetVisibleIndex: visibleColIdx,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      startScrollLeft: scrollLeft,
      currentScrollLeft: scrollLeft,
      dragCenterClientOffsetX,
      lastClientX: event.clientX,
      direction: 0,
      columnRects,
      previewElement: null,
      dragging: false,
      referenceMode: false,
      referenceUnavailable: false,
    };
    columnHeaderPendingClientX = event.clientX;
    window.addEventListener("pointermove", onColumnHeaderPointerMove, true);
    window.addEventListener("pointerup", onColumnHeaderPointerUp, true);
    window.addEventListener("pointercancel", onColumnHeaderPointerCancel, true);
    window.addEventListener("blur", onColumnHeaderPointerCancel, true);
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
    return { "opacity-0 pointer-events-none": state?.dragging && !state.referenceMode && state.sourceVisibleIndex === visibleColIdx };
  }

  function columnHeaderPreviewOffset(visibleColIdx: number): number {
    const state = columnHeaderDragState.value;
    if (!state || state.referenceMode) return 0;
    const scrollCompensation = state.sourceVisibleIndex < frozenColumnCount.value ? 0 : state.currentScrollLeft - state.startScrollLeft;
    return columnHeaderPreviewOffsetForColumn({
      columnDragActive: state.dragging,
      visibleColIdx,
      sourceVisibleIndex: state.sourceVisibleIndex,
      targetVisibleIndex: state.targetVisibleIndex,
      startX: state.startX,
      currentX: state.currentX + scrollCompensation,
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
    return state?.dragging && !state.referenceMode ? state.sourceVisibleIndex : null;
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
