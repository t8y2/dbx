import type { CellValue } from "@/lib/cellValue";
import type { RowStatus } from "@/lib/gridRowStatus";
import {
  DATA_GRID_DARK_SEARCH_COLORS,
  resolveDataGridPaintTheme,
  type DataGridPaintTheme,
} from "@/lib/dataGridPaintTheme";

export const CANVAS_DATA_GRID_ROW_HEIGHT = 26;

export interface CanvasDataGridRow {
  id: number;
  displayIndex: number;
  data: CellValue[];
  isNew: boolean;
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

export interface CanvasSingleSelectedCell {
  rowIndex: number;
  visibleColIdx: number;
}

export interface CanvasSearchMatch {
  displayRow: number;
  col: number;
}

export interface DrawCanvasDataGridOptions {
  canvas: HTMLCanvasElement;
  scroller: HTMLElement;
  width: number;
  height: number;
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
  singleSelectedCell: CanvasSingleSelectedCell | null;
  searchMatchKeys: ReadonlySet<string>;
  currentSearchMatch: CanvasSearchMatch | null;
  formatCell: (value: CellValue, columnIndex: number) => string;
  isRowActive: (rowIndex: number) => boolean;
  isRowSelected: (rowId: number) => boolean;
  rowCellsUseSelectionVisual: (rowId: number) => boolean;
  cellIsSelected: (rowIndex: number, visibleColIdx: number) => boolean;
  cellCanHover: (row: CanvasDataGridRow, actualColIdx: number) => boolean;
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
  return `"Geist Variable Tabular", ${fontFamily}`;
}

const FIT_CANVAS_TEXT_CACHE_MAX = 10000;
const fitCanvasTextCache = new Map<string, string>();

export function clearFitCanvasTextCache(): void {
  fitCanvasTextCache.clear();
}

function fitCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
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
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(text.slice(0, mid)).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  const result = text.slice(0, low);
  if (fitCanvasTextCache.size >= FIT_CANVAS_TEXT_CACHE_MAX) fitCanvasTextCache.clear();
  fitCanvasTextCache.set(cacheKey, result);
  return result;
}

function canvasFont(style: {
  family: string;
  sizePx: number;
  style?: string;
  weight?: string | number;
  lineHeight?: string;
}): string {
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

function resolveCanvasRenderState(canvas: HTMLCanvasElement, isDark: boolean, styleKey?: string): CanvasRenderState {
  const cacheKey = `${styleKey ?? "default"}:${isDark ? "dark" : "light"}`;
  const cached = canvasRenderStateCache.get(canvas);
  if (cached?.cacheKey === cacheKey) return cached;

  const canvasStyle = getComputedStyle(canvas);
  const fontFamily =
    canvasStyle.fontFamily || `"Geist Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
  const fontSize = Number.parseFloat(canvasStyle.fontSize) || 12;
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
    singleSelectedCell,
    searchMatchKeys,
    currentSearchMatch,
    formatCell,
    isRowActive,
    isRowSelected,
    rowCellsUseSelectionVisual,
    cellIsSelected,
    cellCanHover,
  } = options;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
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
  ctx.clearRect(0, 0, width, height);

  const {
    normalFont,
    tabularFont,
    semiboldFont,
    italicFont,
    theme,
    searchFill,
    currentSearchFill,
    currentSearchBorder,
  } = resolveCanvasRenderState(canvas, isDark, styleKey);

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

  for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
    const item = rowAt(rowIndex);
    if (!item) continue;
    const y = rowIndex * CANVAS_DATA_GRID_ROW_HEIGHT - scrollTop;
    const rowIsActive = isRowActive(item.displayIndex);
    const rowBase = item.isDeleted
      ? theme.rowDeleted
      : item.isNew && !rowIsActive
        ? theme.rowNew
        : item.displayIndex % 2 === 1 && !rowIsActive
          ? theme.rowMuted
          : theme.background;
    ctx.globalAlpha = item.isDeleted ? 0.7 : 1;
    ctx.fillStyle = rowBase;
    ctx.fillRect(0, y, width, CANVAS_DATA_GRID_ROW_HEIGHT);

    let rowNumberFill =
      item.status === "new"
        ? theme.rowNumberNew
        : item.status === "edited"
          ? theme.rowNumberEdited
          : item.status === "deleted"
            ? theme.rowNumberDeleted
            : theme.rowNumberDefault;
    if (rowIsActive && !item.isDeleted) rowNumberFill = theme.rowNumberActive;
    if (isRowSelected(item.id) && item.status === "clean") rowNumberFill = theme.rowNumberSelected;
    ctx.fillStyle = rowNumberFill;
    ctx.fillRect(0, y, rowNumberWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
    if (
      hoverCell?.rowIndex === item.displayIndex &&
      hoverCell.visibleColIdx < 0 &&
      !isScrolling &&
      item.status === "clean" &&
      !rowIsActive &&
      !isRowSelected(item.id)
    ) {
      ctx.fillStyle = theme.cellHover;
      ctx.fillRect(0, y, rowNumberWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
    }
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(rowNumberWidth + 0.5, y);
    ctx.lineTo(rowNumberWidth + 0.5, y + CANVAS_DATA_GRID_ROW_HEIGHT);
    ctx.stroke();

    const rowNumberText =
      item.status === "new"
        ? theme.rowNumberTextNew
        : item.status === "edited"
          ? theme.rowNumberTextEdited
          : item.status === "deleted"
            ? theme.rowNumberTextDeleted
            : isRowSelected(item.id)
              ? theme.primary
              : theme.rowNumberTextClean;
    ctx.fillStyle = rowNumberText;
    ctx.font = item.status === "new" || item.status === "edited" || isRowSelected(item.id) ? semiboldFont : normalFont;
    ctx.textAlign = "center";
    ctx.fillText(String(item.displayIndex + 1), rowNumberWidth / 2, y + CANVAS_DATA_GRID_ROW_HEIGHT / 2);
    ctx.font = normalFont;

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
        const isSingleSelectedCell =
          singleSelectedCell?.rowIndex === item.displayIndex && singleSelectedCell.visibleColIdx === visibleColIdx;
        const isDirtyCell = item.isDirtyCol[actualColIdx];
        const selectedFillVisual =
          rowSelectionVisual || (selectedCell && !isSingleSelectedCell && (!rowIsActive || isDirtyCell));
        const selectedBorderVisual = rowSelectionVisual || selectedCell;
        const isSearchMatch = paintSearchMatches && searchMatchKeys.has(`${item.displayIndex}:${actualColIdx}`);
        const isCurrentSearchMatch =
          paintSearchMatches &&
          currentSearchMatch?.displayRow === item.displayIndex &&
          currentSearchMatch.col === actualColIdx;
        const clippedX = Math.max(x, rowNumberWidth);
        const cellPaintWidth = colWidth - Math.max(0, clippedX - x);

        if (isDirtyCell) {
          ctx.fillStyle = theme.cellDirty;
          ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
        }
        if (
          hoverCell?.rowIndex === item.displayIndex &&
          hoverCell.visibleColIdx === visibleColIdx &&
          !isScrolling &&
          !isSearchMatch &&
          !isCurrentSearchMatch &&
          cellCanHover(item, actualColIdx)
        ) {
          ctx.fillStyle = theme.cellHover;
          ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
        }
        if (selectedFillVisual) {
          ctx.fillStyle = isDirtyCell ? theme.cellSelectedDirty : theme.cellSelected;
          ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
        }
        if (rowIsActive && !item.isDeleted && !isDirtyCell) {
          ctx.fillStyle = theme.cellActive;
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

        ctx.save();
        ctx.beginPath();
        ctx.rect(clippedX, y, Math.min(cellPaintWidth, width - clippedX), CANVAS_DATA_GRID_ROW_HEIGHT);
        ctx.clip();
        const value = item.data[actualColIdx];
        ctx.textAlign = "left";
        ctx.fillStyle = value === null ? theme.mutedForeground : theme.foreground;
        ctx.font = value === null ? italicFont : typeof value === "number" ? tabularFont : normalFont;
        setCanvasNumericVariant(ctx, typeof value === "number" ? "tabular-nums" : "normal");
        const textLeft = x + 12;
        const paddedMaxWidth = Math.max(0, x + colWidth - textLeft - 12);
        const isEditingThisCell = editingCell?.rowId === item.id && editingCell.col === actualColIdx;
        const displayText = isEditingThisCell ? "" : formatCell(value, actualColIdx);
        const needsTruncation = ctx.measureText(displayText).width > paddedMaxWidth;
        const textMaxWidth = needsTruncation ? Math.max(0, x + colWidth - textLeft) : paddedMaxWidth;
        const text = isEditingThisCell ? displayText : fitCanvasText(ctx, displayText, textMaxWidth);
        ctx.fillText(text, textLeft, y + CANVAS_DATA_GRID_ROW_HEIGHT / 2);
        if (item.isDeleted && text) {
          const textWidth = Math.min(ctx.measureText(text).width, textMaxWidth);
          ctx.strokeStyle = theme.foreground;
          ctx.beginPath();
          ctx.moveTo(textLeft, y + CANVAS_DATA_GRID_ROW_HEIGHT / 2);
          ctx.lineTo(textLeft + textWidth, y + CANVAS_DATA_GRID_ROW_HEIGHT / 2);
          ctx.stroke();
        }
        ctx.restore();
        setCanvasNumericVariant(ctx, "normal");
        ctx.font = normalFont;

        ctx.strokeStyle = theme.border;
        ctx.beginPath();
        ctx.moveTo(x + colWidth - 0.5, y);
        ctx.lineTo(x + colWidth - 0.5, y + CANVAS_DATA_GRID_ROW_HEIGHT);
        ctx.stroke();

        if (selectedBorderVisual && cellPaintWidth >= 2) {
          const selectedLeftX = clippedX + 0.5;
          const selectedRightX = clippedX + cellPaintWidth - 1.5;
          const selectedTopY = y + 0.5;
          const selectedBottomY = y + CANVAS_DATA_GRID_ROW_HEIGHT - 1.5;
          ctx.strokeStyle = theme.cellSelectedBorder;
          ctx.beginPath();
          ctx.moveTo(selectedLeftX, selectedTopY);
          ctx.lineTo(selectedRightX, selectedTopY);
          ctx.moveTo(selectedLeftX, selectedBottomY);
          ctx.lineTo(selectedRightX, selectedBottomY);
          ctx.moveTo(selectedLeftX, selectedTopY);
          ctx.lineTo(selectedLeftX, selectedBottomY);
          ctx.moveTo(selectedRightX, selectedTopY);
          ctx.lineTo(selectedRightX, selectedBottomY);
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
    if (!isRowSelected(item.id)) {
      ctx.strokeStyle = theme.border;
      ctx.beginPath();
      ctx.moveTo(0, y + CANVAS_DATA_GRID_ROW_HEIGHT - 0.5);
      ctx.lineTo(width, y + CANVAS_DATA_GRID_ROW_HEIGHT - 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
