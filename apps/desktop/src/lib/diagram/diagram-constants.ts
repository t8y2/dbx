/** provide/inject key for the currently hovered relationship edge id */
export const DIAGRAM_HOVERED_EDGE_KEY = "diagramHoveredEdgeId";
/** provide/inject key for table/layer obstacle rects used by edge routing */
export const DIAGRAM_EDGE_OBSTACLES_KEY = "diagramEdgeObstacles";

export const CARD_WIDTH = 360;
export const CARD_HEADER_HEIGHT = 44;
export const COLUMN_ROW_HEIGHT = 24;
export const CARD_BOTTOM_PADDING = 12;
/** Fixed width for the data-type column inside a table card */
export const COLUMN_TYPE_WIDTH = 112;
/** Display truncation caps (CSS truncate + char limit) */
export const COLUMN_NAME_MAX_CHARS = 36;
export const COLUMN_TYPE_MAX_CHARS = 22;
export const TABLE_NAME_MAX_CHARS = 40;

export const GAP_X = 80;
export const GAP_Y = 60;
export const MARGIN = 40;

/** Handle inset from card edge (0 = centered on border) */
export const EDGE_HANDLE_OUTSET = 0;
/** Extra clearance before orthogonal bends around a node */
export const EDGE_ROUTE_OFFSET = 36;
/** Idle / hover stroke widths for relationship edges */
export const EDGE_STROKE_IDLE = 1.6;
export const EDGE_STROKE_HOVER = 3.5;
/** Delay before hover opens edge detail popover / highlight */
export const EDGE_POPOVER_OPEN_DELAY_MS = 400;
/** Delay before hover popover closes after leaving edge / popover */
export const EDGE_POPOVER_CLOSE_DELAY_MS = 220;

/** Padding used by ELK nested layer boxes */
export const LAYER_PADDING = 30;
export const LAYER_HEADER_HEIGHT = 40;

/** Tighter padding for Size-to-Fit / empty layer chrome */
export const LAYER_CONTENT_PADDING = 20;
export const EMPTY_LAYER_WIDTH = 240;
export const EMPTY_LAYER_HEIGHT = LAYER_HEADER_HEIGHT + LAYER_CONTENT_PADDING;

export function tableCardHeight(columnCount: number): number {
  return CARD_HEADER_HEIGHT + columnCount * COLUMN_ROW_HEIGHT + CARD_BOTTOM_PADDING;
}

/** LTR wrap column count from available canvas width (at least 1). */
export function columnsPerRowForWidth(viewportWidth?: number): number {
  if (!viewportWidth || viewportWidth <= 0) return 6;
  const usable = viewportWidth - MARGIN * 2;
  const cols = Math.floor(usable / (CARD_WIDTH + GAP_X));
  return Math.max(1, cols < 1 ? 1 : cols);
}
