import { firstLineCellDisplayValue, type CellValue } from "@/lib/dataGrid/cellValue";
import type { RowStatus } from "@/lib/dataGrid/gridRowStatus";
import { DATA_GRID_DARK_SEARCH_COLORS, resolveDataGridPaintTheme, type DataGridPaintTheme } from "@/lib/dataGrid/dataGridPaintTheme";

export const CANVAS_DATA_GRID_ROW_HEIGHT = 26;

export interface CanvasDataGridRow {
  id: number;
  displayIndex: number;
  data: CellValue[];
  isNew: boolean;
  isDraft?: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: RowStatus;
}

export interface CanvasHoverCell {
  rowIndex: number;
  visibleColIdx: number;
}

export interface CanvasEditingCell {
  rowId: number;
  col: number;
}

export interface CanvasSearchMatch {
  kind: "cell" | "column";
  displayRow: number;
  col: number;
}

export interface DrawCanvasDataGridOptions {
  canvas: HTMLCanvasElement;
  scroller: HTMLElement;
  width: number;
  height: number;
  pixelRatio?: number;
  isDark: boolean;
  styleKey?: string;
  rowCount: number;
  rowAt: (rowIndex: number) => CanvasDataGridRow | undefined;
  renderedColumnWidths: number[];
  renderedColumnOffsets?: number[];
  visibleColumnIndexes: number[];
  rowNumberWidth: number;
  hoverCell: CanvasHoverCell | null;
  isScrolling: boolean;
  editingCell: CanvasEditingCell | null;
  searchMatchKeys: ReadonlySet<string>;
  currentSearchMatch: CanvasSearchMatch | null;
  formatCell: (value: CellValue, columnIndex: number) => string;
  draftCellPlaceholder?: string;
  isRowActive: (rowIndex: number) => boolean;
  rowCellsUseSelectionVisual: (rowId: number) => boolean;
  cellIsSelected: (rowIndex: number, visibleColIdx: number) => boolean;
  cellCanHover: (row: CanvasDataGridRow, actualColIdx: number) => boolean;
  infiniteScrollEnabled: boolean;
  pageSize: number;
  currentPage: number;
}

type NumericCanvasContext = CanvasRenderingContext2D & {
  fontVariantNumeric?: string;
};

interface CanvasRenderState {
  cacheKey: string;
  normalFont: string;
  tabularFont: string;
  semiboldFont: string;
  italicFont: string;
  theme: DataGridPaintTheme;
  searchFill: string;
  currentSearchFill: string;
  currentSearchBorder: string;
}

const canvasRenderStateCache = new WeakMap<HTMLCanvasElement, CanvasRenderState>();

function setCanvasNumericVariant(ctx: CanvasRenderingContext2D, value: "normal" | "tabular-nums") {
  const numericCtx = ctx as NumericCanvasContext;
  if ("fontVariantNumeric" in numericCtx) numericCtx.fontVariantNumeric = value;
}

function canvasTabularFontFamily(fontFamily: string): string {
  return fontFamily.replace(/"Geist Variable"/g, '"Geist Variable Tabular"');
}

const FIT_CANVAS_TEXT_CACHE_MAX = 10000;
const fitCanvasTextCache = new Map<string, string>();

export function clearFitCanvasTextCache(): void {
  fitCanvasTextCache.clear();
}

export function fitCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const font = ctx.font;
  const cacheKey = `${font}|${text}|${maxWidth}`;
  const cached = fitCanvasTextCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (ctx.measureText(text).width <= maxWidth) {
    if (fitCanvasTextCache.size >= FIT_CANVAS_TEXT_CACHE_MAX) fitCanvasTextCache.clear();
    fitCanvasTextCache.set(cacheKey, text);
    return text;
  }
  const ellipsis = "...";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(text.slice(0, mid)).width + ellipsisWidth <= maxWidth) low = mid;
    else high = mid - 1;
  }
  const result = text.slice(0, low) + ellipsis;
  if (fitCanvasTextCache.size >= FIT_CANVAS_TEXT_CACHE_MAX) fitCanvasTextCache.clear();
  fitCanvasTextCache.set(cacheKey, result);
  return result;
}

function canvasFont(style: { family: string; sizePx: number; style?: string; weight?: string | number; lineHeight?: string }): string {
  const fontStyle = style.style && style.style !== "normal" ? `${style.style} ` : "";
  const fontWeight = style.weight && style.weight !== "400" && style.weight !== "normal" ? `${style.weight} ` : "";
  const lineHeight = style.lineHeight && style.lineHeight !== "normal" ? `/${style.lineHeight}` : "";
  return `${fontStyle}${fontWeight}${style.sizePx}px${lineHeight} ${style.family}`;
}

function columnOffsets(widths: number[]): number[] {
  const offsets = Array.from({ length: widths.length + 1 }, () => 0);
  offsets[0] = 0;
  for (let index = 0; index < widths.length; index++) {
    offsets[index + 1] = offsets[index] + (widths[index] ?? 0);
  }
  return offsets;
}

function firstVisibleColumn(offsets: number[], contentStart: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((offsets[mid + 1] ?? 0) < contentStart) low = mid + 1;
    else high = mid;
  }
  return low;
}

function alignCanvasPixel(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

function crispCanvasLine(value: number, dpr: number): number {
  return alignCanvasPixel(value, dpr) + 0.5 / dpr;
}

function resolveCanvasRenderState(canvas: HTMLCanvasElement, isDark: boolean, styleKey?: string): CanvasRenderState {
  const canvasStyle = getComputedStyle(canvas);
  const cacheKey = `${styleKey ?? "default"}:${isDark ? "dark" : "light"}:${canvasStyle.fontFamily}:${canvasStyle.fontSize}`;
  const cached = canvasRenderStateCache.get(canvas);
  if (cached?.cacheKey === cacheKey) return cached;

  const fontFamily = canvasStyle.fontFamily || `"Geist Variable Tabular", "Geist Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
  const fontSize = Number.parseFloat(canvasStyle.fontSize) || 13;
  const lineHeight = canvasStyle.lineHeight;
  const normalFont = canvasFont({
    family: fontFamily,
    sizePx: fontSize,
    weight: canvasStyle.fontWeight,
    lineHeight,
  });
  const tabularFont = canvasFont({
    family: canvasTabularFontFamily(fontFamily),
    sizePx: fontSize,
    weight: canvasStyle.fontWeight,
    lineHeight,
  });
  const semiboldFont = canvasFont({ family: fontFamily, sizePx: fontSize, weight: 600, lineHeight });
  const italicFont = canvasFont({
    family: fontFamily,
    sizePx: fontSize,
    style: "italic",
    weight: canvasStyle.fontWeight,
    lineHeight,
  });
  const theme = resolveDataGridPaintTheme({
    getVar: (name) => canvasStyle.getPropertyValue(name),
    isDark,
  });
  const state = {
    cacheKey,
    normalFont,
    tabularFont,
    semiboldFont,
    italicFont,
    theme,
    searchFill: isDark ? DATA_GRID_DARK_SEARCH_COLORS.match : theme.cellSearch,
    currentSearchFill: isDark ? DATA_GRID_DARK_SEARCH_COLORS.current : theme.cellCurrentSearch,
    currentSearchBorder: isDark ? DATA_GRID_DARK_SEARCH_COLORS.currentBorder : theme.cellCurrentSearchBorder,
  };
  canvasRenderStateCache.set(canvas, state);
  return state;
}

export function drawCanvasDataGrid(options: DrawCanvasDataGridOptions) {
  const {
    canvas,
    scroller,
    width,
    height,
    isDark,
    styleKey,
    rowCount,
    rowAt,
    renderedColumnWidths,
    renderedColumnOffsets,
    visibleColumnIndexes,
    rowNumberWidth,
    hoverCell,
    isScrolling,
    editingCell,
    searchMatchKeys,
    currentSearchMatch,
    formatCell,
    draftCellPlaceholder,
    isRowActive,
    rowCellsUseSelectionVisual,
    cellIsSelected,
    cellCanHover,
    infiniteScrollEnabled,
    pageSize,
    currentPage,
  } = options;
  const dpr = Math.max(1, options.pixelRatio ?? window.devicePixelRatio ?? 1);
  const pixelWidth = Math.max(1, Math.ceil(width * dpr));
  const pixelHeight = Math.max(1, Math.ceil(height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const canvasWidth = `${width}px`;
  const canvasHeight = `${height}px`;
  if (canvas.style.width !== canvasWidth) canvas.style.width = canvasWidth;
  if (canvas.style.height !== canvasHeight) canvas.style.height = canvasHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);

  const { normalFont, tabularFont, semiboldFont, italicFont, theme, searchFill, currentSearchFill, currentSearchBorder } = resolveCanvasRenderState(canvas, isDark, styleKey);

  const scrollTop = scroller.scrollTop;
  const scrollLeft = scroller.scrollLeft;
  const firstRow = Math.max(0, Math.floor(scrollTop / CANVAS_DATA_GRID_ROW_HEIGHT));
  const lastRow = Math.min(rowCount - 1, Math.ceil((scrollTop + height) / CANVAS_DATA_GRID_ROW_HEIGHT));

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = normalFont;
  ctx.textBaseline = "middle";

  const offsets = renderedColumnOffsets ?? columnOffsets(renderedColumnWidths);
  const contentStart = Math.max(0, scrollLeft - rowNumberWidth);
  const firstCol = firstVisibleColumn(offsets, contentStart);
  const columnOffset = offsets[firstCol] ?? 0;
  const paintSearchMatches = !isScrolling && searchMatchKeys.size > 0;
  const rowNumberBorderX = crispCanvasLine(rowNumberWidth - 1, dpr);
  const rowNumberTextX = alignCanvasPixel(Math.max(0, rowNumberWidth - 1) / 2, dpr);
  const rowTextOffsetY = alignCanvasPixel(CANVAS_DATA_GRID_ROW_HEIGHT / 2, dpr);

  for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
    const item = rowAt(rowIndex);
    if (!item) continue;
    const y = rowIndex * CANVAS_DATA_GRID_ROW_HEIGHT - scrollTop;
    const rowIsActive = isRowActive(item.displayIndex);

    const rowBase = item.isDeleted ? theme.rowDeleted : item.isNew && !rowIsActive ? theme.rowNew : item.isDraft && !rowIsActive ? theme.rowMuted : item.displayIndex % 2 === 1 && !rowIsActive ? theme.rowMuted : theme.background;
    const rowBorderY = crispCanvasLine(y + CANVAS_DATA_GRID_ROW_HEIGHT - 1, dpr);
    ctx.globalAlpha = item.isDeleted ? 0.7 : 1;
    ctx.fillStyle = rowIsActive && !item.isDeleted ? theme.cellSelectedSingle : rowBase;
    ctx.fillRect(0, y, width, CANVAS_DATA_GRID_ROW_HEIGHT);

    const rowNumberFill = item.status === "draft" ? theme.rowNumberDefault : item.status === "new" ? theme.rowNumberNew : item.status === "edited" ? theme.rowNumberEdited : item.status === "deleted" ? theme.rowNumberDeleted : theme.rowNumberDefault;
    ctx.fillStyle = rowNumberFill;
    ctx.fillRect(0, y, rowNumberWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(rowNumberBorderX, y);
    ctx.lineTo(rowNumberBorderX, y + CANVAS_DATA_GRID_ROW_HEIGHT);
    ctx.stroke();

    const rowNumberText = item.status === "new" ? theme.rowNumberTextNew : item.status === "edited" ? theme.rowNumberTextEdited : item.status === "deleted" ? theme.rowNumberTextDeleted : theme.rowNumberTextClean;
    ctx.fillStyle = rowNumberText;
    ctx.font = item.status === "new" || item.status === "edited" || item.status === "draft" ? semiboldFont : normalFont;
    ctx.textAlign = "center";
    const textY = alignCanvasPixel(y + rowTextOffsetY, dpr);
    if (item.isDraft) {
      ctx.fillText("*", rowNumberTextX, textY);
    } else if (infiniteScrollEnabled) {
      ctx.fillText(String(item.displayIndex + 1), rowNumberTextX, textY);
    } else {
      ctx.fillText(String(item.displayIndex + 1 + pageSize * (currentPage - 1)), rowNumberTextX, textY);
    }
    ctx.font = normalFont;

    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(0, rowBorderY);
    ctx.lineTo(width, rowBorderY);
    ctx.stroke();
    let x = rowNumberWidth + columnOffset - scrollLeft;
    for (let visibleColIdx = firstCol; visibleColIdx < renderedColumnWidths.length && x < width; visibleColIdx++) {
      const colWidth = renderedColumnWidths[visibleColIdx] ?? 0;
      const actualColIdx = visibleColumnIndexes[visibleColIdx];
      if (actualColIdx === undefined) {
        x += colWidth;
        continue;
      }
      if (x + colWidth >= rowNumberWidth) {
        const selectedCell = cellIsSelected(item.displayIndex, visibleColIdx);
        const rowSelectionVisual = rowCellsUseSelectionVisual(item.id);
        const isDirtyCell = item.isDirtyCol[actualColIdx];
        const selectedFillVisual = rowSelectionVisual || selectedCell;
        const selectedBorderVisual = rowSelectionVisual || selectedCell;
        const isSearchMatch = paintSearchMatches && searchMatchKeys.has(`cell:${item.displayIndex}:${actualColIdx}`);
        const isCurrentSearchMatch = paintSearchMatches && currentSearchMatch?.displayRow === item.displayIndex && currentSearchMatch.col === actualColIdx;
        const clippedX = Math.max(x, rowNumberWidth);
        const cellPaintWidth = colWidth - Math.max(0, clippedX - x);

        if (isDirtyCell && !selectedFillVisual) {
          ctx.fillStyle = theme.cellDirty;
          ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
        }
        if (hoverCell?.rowIndex === item.displayIndex && hoverCell.visibleColIdx === visibleColIdx && !isScrolling && !isSearchMatch && !isCurrentSearchMatch && !isDirtyCell && cellCanHover(item, actualColIdx)) {
          ctx.fillStyle = theme.cellHover;
          ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
        }
        if ((rowIsActive || selectedCell) && !item.isDeleted && !isDirtyCell) {
          ctx.fillStyle = theme.cellSelectedSingle;
          ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
        }
        if (selectedFillVisual && isDirtyCell) {
          ctx.fillStyle = theme.cellSelectedDirty;
          ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
        }
        if (isSearchMatch) {
          ctx.fillStyle = searchFill;
          ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
        }
        if (isCurrentSearchMatch) {
          ctx.fillStyle = currentSearchFill;
          ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
        }

        ctx.strokeStyle = theme.border;
        ctx.beginPath();
        ctx.moveTo(clippedX, rowBorderY);
        ctx.lineTo(Math.min(width, clippedX + cellPaintWidth), rowBorderY);
        ctx.stroke();

        ctx.save();
        ctx.beginPath();
        ctx.rect(clippedX, y, Math.min(cellPaintWidth, width - clippedX), CANVAS_DATA_GRID_ROW_HEIGHT);
        ctx.clip();
        const value = item.data[actualColIdx];
        ctx.textAlign = "left";
        ctx.fillStyle = value === null ? theme.mutedForeground : theme.foreground;
        ctx.font = value === null ? italicFont : tabularFont;
        setCanvasNumericVariant(ctx, value === null ? "normal" : "tabular-nums");
        const textLeft = alignCanvasPixel(x + 12, dpr);
        const paddedMaxWidth = Math.max(0, x + colWidth - textLeft - 12);
        const isEditingThisCell = editingCell?.rowId === item.id && editingCell.col === actualColIdx;
        const rawDisplayText = item.isDraft && value === null ? (draftCellPlaceholder ?? "") : formatCell(value, actualColIdx);
        const displayText = isEditingThisCell ? "" : firstLineCellDisplayValue(rawDisplayText);
        const needsTruncation = ctx.measureText(displayText).width > paddedMaxWidth;
        const textMaxWidth = needsTruncation ? Math.max(0, x + colWidth - textLeft) : paddedMaxWidth;
        const text = isEditingThisCell ? displayText : fitCanvasText(ctx, displayText, textMaxWidth - 12);
        ctx.fillText(text, textLeft, textY);
        if (item.isDeleted && text) {
          const textWidth = Math.min(ctx.measureText(text).width, textMaxWidth);
          ctx.strokeStyle = theme.foreground;
          ctx.beginPath();
          ctx.moveTo(textLeft, textY);
          ctx.lineTo(alignCanvasPixel(textLeft + textWidth, dpr), textY);
          ctx.stroke();
        }
        ctx.restore();
        setCanvasNumericVariant(ctx, "normal");
        ctx.font = normalFont;

        ctx.strokeStyle = theme.border;
        ctx.beginPath();
        const columnBorderX = crispCanvasLine(x + colWidth - 1, dpr);
        ctx.moveTo(columnBorderX, y);
        ctx.lineTo(columnBorderX, y + CANVAS_DATA_GRID_ROW_HEIGHT);
        ctx.stroke();

        if (selectedBorderVisual && cellPaintWidth >= 2) {
          const selectedLeftX = clippedX + 0.5;
          const selectedRightX = clippedX + cellPaintWidth - 1.5;
          const selectedTopY = Math.max(y + 0.5, 1);
          const drawSelectedLeftBorder = selectedLeftX >= rowNumberWidth + 0.5;
          ctx.strokeStyle = selectedCell && !isDirtyCell ? theme.cellSelectedSingleBorder : theme.cellSelectedBorder;
          ctx.beginPath();
          ctx.moveTo(selectedLeftX, selectedTopY);
          ctx.lineTo(selectedRightX, selectedTopY);
          ctx.moveTo(selectedLeftX, rowBorderY);
          ctx.lineTo(selectedRightX, rowBorderY);
          if (drawSelectedLeftBorder) {
            ctx.moveTo(selectedLeftX, selectedTopY);
            ctx.lineTo(selectedLeftX, rowBorderY);
          }
          ctx.moveTo(selectedRightX, selectedTopY);
          ctx.lineTo(selectedRightX, rowBorderY);
          ctx.stroke();
        }

        if (isCurrentSearchMatch) {
          ctx.strokeStyle = currentSearchBorder;
          ctx.lineWidth = 2;
          ctx.strokeRect(clippedX + 1, y + 1, Math.max(0, cellPaintWidth - 2), CANVAS_DATA_GRID_ROW_HEIGHT - 2);
          ctx.lineWidth = 1;
        }
      }
      x += colWidth;
    }
    ctx.globalAlpha = 1;
  }
}
