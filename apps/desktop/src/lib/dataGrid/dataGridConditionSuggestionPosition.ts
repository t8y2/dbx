export interface DataGridConditionSuggestionRect {
  left: number;
  bottom: number;
  width: number;
}

export interface DataGridConditionSuggestionPositionOptions {
  viewportWidth: number;
  minWidth?: number;
  preferredWidth?: number;
  maxWidth?: number;
  viewportMargin?: number;
  topOffset?: number;
}

export interface DataGridConditionSuggestionPosition {
  left: number;
  top: number;
  width: number;
}

export interface DataGridConditionSuggestionContent {
  value: string;
  kind: "column" | "history";
  comment?: string | null;
}

const COMMENTED_SUGGESTION_MIN_WIDTH = 360;
const COMMENTED_SUGGESTION_MAX_WIDTH = 520;

function textWidthUnits(value: string): number {
  return [...value].reduce((total, character) => total + (character.charCodeAt(0) > 0xff ? 2 : 1), 0);
}

export function getDataGridConditionSuggestionPreferredWidth(suggestions: readonly DataGridConditionSuggestionContent[]): number | undefined {
  const hasComment = suggestions.some((suggestion) => suggestion.kind === "column" && !!suggestion.comment?.trim());
  if (!hasComment) return undefined;
  const longestFieldUnits = suggestions.reduce((longest, suggestion) => (suggestion.kind === "column" ? Math.max(longest, textWidthUnits(suggestion.value)) : longest), 0);
  return Math.min(COMMENTED_SUGGESTION_MAX_WIDTH, Math.max(COMMENTED_SUGGESTION_MIN_WIDTH, Math.ceil(longestFieldUnits * 7.5 + 208)));
}

export function getDataGridConditionSuggestionPosition(inputRect: DataGridConditionSuggestionRect, options: DataGridConditionSuggestionPositionOptions): DataGridConditionSuggestionPosition {
  const minWidth = options.minWidth ?? 180;
  const viewportMargin = options.viewportMargin ?? 8;
  const topOffset = options.topOffset ?? 2;
  const availableWidth = Math.max(0, options.viewportWidth - viewportMargin * 2);
  const widthLimit = Math.min(availableWidth, options.maxWidth ?? availableWidth);
  const width = Math.min(Math.max(inputRect.width, minWidth, options.preferredWidth ?? 0), widthLimit);
  const maxLeft = Math.max(viewportMargin, options.viewportWidth - viewportMargin - width);
  const left = Math.min(Math.max(inputRect.left, viewportMargin), maxLeft);

  return {
    left,
    top: inputRect.bottom + topOffset,
    width,
  };
}
