export interface DataGridConditionSuggestionRect {
  left: number;
  bottom: number;
  width: number;
}

export interface DataGridConditionSuggestionPositionOptions {
  viewportWidth: number;
  minWidth?: number;
  viewportMargin?: number;
  topOffset?: number;
}

export interface DataGridConditionSuggestionPosition {
  left: number;
  top: number;
  width: number;
}

export function getDataGridConditionSuggestionPosition(inputRect: DataGridConditionSuggestionRect, options: DataGridConditionSuggestionPositionOptions): DataGridConditionSuggestionPosition {
  const minWidth = options.minWidth ?? 180;
  const viewportMargin = options.viewportMargin ?? 8;
  const topOffset = options.topOffset ?? 2;
  const availableWidth = Math.max(minWidth, options.viewportWidth - viewportMargin * 2);
  const width = Math.min(Math.max(inputRect.width, minWidth), availableWidth);
  const maxLeft = Math.max(viewportMargin, options.viewportWidth - viewportMargin - width);
  const left = Math.min(Math.max(inputRect.left, viewportMargin), maxLeft);

  return {
    left,
    top: inputRect.bottom + topOffset,
    width,
  };
}
