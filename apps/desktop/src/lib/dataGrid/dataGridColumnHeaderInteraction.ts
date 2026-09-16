export interface ColumnHeaderTooltipState {
  columnDragActive: boolean;
  columnResizeActive: boolean;
}

export function columnHeaderTooltipDisabled(state: ColumnHeaderTooltipState): boolean {
  return state.columnDragActive || state.columnResizeActive;
}

export interface ColumnHeaderCanvasPointerState {
  columnDragActive: boolean;
  columnResizeActive: boolean;
}

export function columnHeaderCanvasPointerDisabled(state: ColumnHeaderCanvasPointerState): boolean {
  return state.columnDragActive || state.columnResizeActive;
}

export interface ColumnHeaderClickGuardState {
  now: number;
  guardUntil: number;
  suppressNextClick: boolean;
}

export function columnHeaderClickShouldBeSuppressed(state: ColumnHeaderClickGuardState): boolean {
  return state.suppressNextClick || state.now < state.guardUntil;
}

export interface ColumnHeaderDragAutoScrollState {
  clientX: number;
  viewportLeft: number;
  viewportRight: number;
  threshold?: number;
  maxStep?: number;
}

export function columnHeaderDragAutoScrollDelta(state: ColumnHeaderDragAutoScrollState): number {
  const threshold = Math.max(1, state.threshold ?? 64);
  const maxStep = Math.max(0, state.maxStep ?? 24);
  if (maxStep === 0) return 0;
  const leftDistance = state.clientX - state.viewportLeft;
  const rightDistance = state.viewportRight - state.clientX;
  const leftActive = leftDistance < threshold;
  const rightActive = rightDistance < threshold;
  const direction = leftActive && (!rightActive || leftDistance <= rightDistance) ? -1 : rightActive ? 1 : 0;
  const edgeDistance = direction < 0 ? leftDistance : direction > 0 ? rightDistance : null;
  if (edgeDistance === null) return 0;

  const intensity = Math.min(1, Math.max(0, (threshold - edgeDistance) / threshold));
  return direction * Math.max(1, Math.round(maxStep * intensity * intensity));
}

export interface ColumnHeaderDropTargetState {
  pointerContentX: number;
  sourceVisibleIndex: number;
  currentTargetIndex: number;
  direction: -1 | 0 | 1;
  columnWidths: readonly number[];
  columnOffsets: readonly number[];
}

export function columnHeaderDropTargetIndex(state: ColumnHeaderDropTargetState): number {
  const otherColumnIndexes = state.columnWidths.map((_, visibleIndex) => visibleIndex).filter((visibleIndex) => visibleIndex !== state.sourceVisibleIndex);
  const maxTargetIndex = otherColumnIndexes.length;
  let targetIndex = Math.max(0, Math.min(state.currentTargetIndex, maxTargetIndex));
  const sourceWidth = state.columnWidths[state.sourceVisibleIndex] ?? 0;

  function previewOffset(columnIndex: number): number {
    return columnHeaderPreviewOffsetForColumn({
      columnDragActive: true,
      visibleColIdx: columnIndex,
      sourceVisibleIndex: state.sourceVisibleIndex,
      targetVisibleIndex: targetIndex,
      startX: 0,
      currentX: 0,
      sourceWidth,
    });
  }

  if (state.direction > 0) {
    while (targetIndex < maxTargetIndex) {
      const columnIndex = otherColumnIndexes[targetIndex];
      const width = state.columnWidths[columnIndex] ?? 0;
      const threshold = (state.columnOffsets[columnIndex] ?? 0) + width / 2 + previewOffset(columnIndex);
      if (state.pointerContentX <= threshold) break;
      targetIndex++;
    }
  } else if (state.direction < 0) {
    while (targetIndex > 0) {
      const columnIndex = otherColumnIndexes[targetIndex - 1];
      const width = state.columnWidths[columnIndex] ?? 0;
      const threshold = (state.columnOffsets[columnIndex] ?? 0) + width / 2 + previewOffset(columnIndex);
      if (state.pointerContentX >= threshold) break;
      targetIndex--;
    }
  }
  return targetIndex;
}

export interface ColumnHeaderPreviewState {
  columnDragActive: boolean;
}

export function columnHeaderPreviewEnabled(state: ColumnHeaderPreviewState): boolean {
  return state.columnDragActive;
}

export interface ColumnHeaderPreviewOffsetState {
  columnDragActive: boolean;
  visibleColIdx: number;
  sourceVisibleIndex: number;
  targetVisibleIndex: number;
  startX: number;
  currentX: number;
  sourceWidth: number;
}

export function columnHeaderPreviewOffsetForColumn(state: ColumnHeaderPreviewOffsetState): number {
  if (!columnHeaderPreviewEnabled(state)) return 0;
  if (state.visibleColIdx === state.sourceVisibleIndex) return state.currentX - state.startX;
  if (state.targetVisibleIndex < state.sourceVisibleIndex && state.visibleColIdx >= state.targetVisibleIndex && state.visibleColIdx < state.sourceVisibleIndex) {
    return state.sourceWidth;
  }
  if (state.targetVisibleIndex > state.sourceVisibleIndex && state.visibleColIdx > state.sourceVisibleIndex && state.visibleColIdx <= state.targetVisibleIndex) {
    return -state.sourceWidth;
  }
  return 0;
}
