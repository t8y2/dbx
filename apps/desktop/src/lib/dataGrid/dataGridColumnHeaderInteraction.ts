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
