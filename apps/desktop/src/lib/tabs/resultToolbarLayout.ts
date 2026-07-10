const OVERFLOW_TOLERANCE_PX = 1;
const EXPAND_HYSTERESIS_PX = 8;

export interface ResultToolbarLayoutState {
  compact: boolean;
  expandedRequiredWidth?: number;
}

export interface ResultToolbarLayoutInput extends ResultToolbarLayoutState {
  resultCount: number;
  toolbarWidth: number;
  tabsViewportWidth: number;
  tabsContentWidth: number;
}

export function nextResultToolbarLayout(input: ResultToolbarLayoutInput): ResultToolbarLayoutState {
  if (input.resultCount < 2) return { compact: false };
  if (input.toolbarWidth <= 0 || input.tabsViewportWidth <= 0) {
    return { compact: input.compact, expandedRequiredWidth: input.expandedRequiredWidth };
  }

  if (input.compact) {
    if (input.expandedRequiredWidth === undefined || input.toolbarWidth >= input.expandedRequiredWidth + EXPAND_HYSTERESIS_PX) {
      return { compact: false };
    }
    return { compact: true, expandedRequiredWidth: input.expandedRequiredWidth };
  }

  const overflowWidth = input.tabsContentWidth - input.tabsViewportWidth;
  if (overflowWidth <= OVERFLOW_TOLERANCE_PX) return { compact: false };
  return {
    compact: true,
    expandedRequiredWidth: input.toolbarWidth + overflowWidth,
  };
}
