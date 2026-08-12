import { firstLineCellDisplayValue, type CellValue } from "@/lib/dataGrid/cellValue";
import { BOOLEAN_CHECKBOX_SIZE, isBooleanCellValue, normalizeBooleanCellValue } from "@/lib/dataGrid/dataGridBooleanColumn";
import { resolveDataGridCellTextRole } from "@/lib/dataGrid/dataGridCellTextVisual";
import type { DataGridTypeVisualKind } from "@/lib/dataGrid/dataGridColumnType";
import { dataGridFrameCoversRow, dataGridFrameIsMultiCell, dataGridSelectionFrameKindAtCell, dataGridSelectionUsesOuterFrame } from "@/lib/dataGrid/dataGridSelectionFrames";
import type { CellSelectionRange } from "@/lib/dataGrid/gridSelection";
import type { RowStatus } from "@/lib/dataGrid/gridRowStatus";
import { DATA_GRID_DARK_SEARCH_COLORS, dataGridTypeForeground, resolveDataGridPaintTheme, type DataGridPaintTheme } from "@/lib/dataGrid/dataGridPaintTheme";

export const CANVAS_DATA_GRID_ROW_HEIGHT = 26;
export const MAX_CANVAS_DATA_GRID_PIXEL_RATIO = 4;

export interface CanvasDevicePixelSize {
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
}

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

export interface CanvasRightAlignedActionCell extends CanvasHoverCell {
  reservedWidth: number;
}

/** 搜索匹配的数值 key：列头匹配 displayRow 为 -1。相比字符串拼接 key，
 * 每次按键构建 matchSet、每帧对可见单元格查询都零字符串分配。
 * ponytail: 列数上限 65536，网格列数远达不到 */
export function dataGridSearchMatchKey(displayRow: number, col: number): number {
  return (displayRow + 1) * 65536 + col;
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
  devicePixelSize?: CanvasDevicePixelSize | null;
  isDark: boolean;
  styleKey?: string;
  rowCount: number;
  rowAt: (rowIndex: number) => CanvasDataGridRow | undefined;
  renderedColumnWidths: number[];
  renderedColumnOffsets?: number[];
  columnPreviewOffsets?: readonly number[];
  columnPreviewSourceVisibleIndex?: number | null;
  visibleColumnIndexes: number[];
  rowNumberWidth: number;
  hoverCell: CanvasHoverCell | null;
  isScrolling: boolean;
  editingCell: CanvasEditingCell | null;
  searchMatchKeys: ReadonlySet<number>;
  currentSearchMatch: CanvasSearchMatch | null;
  formatCell: (value: CellValue, columnIndex: number) => string;
  columnIsBoolean?: (columnIndex: number) => boolean;
  draftCellPlaceholder?: string;
  isRowActive: (rowIndex: number) => boolean;
  rowCellsUseSelectionVisual: (rowId: number) => boolean;
  cellIsSelected: (rowIndex: number, visibleColIdx: number) => boolean;
  /** 连续选区矩形（displayRow/visibleCol 坐标）。用于 Navicat 风格的形态区分：
   * 多格范围浅色填充 + 一圈细外框、内部零描边；1×1 画细边框；离散点选传空数组退回逐格描边 */
  selectionFrames?: readonly CellSelectionRange[];
  cellCanHover: (row: CanvasDataGridRow, actualColIdx: number) => boolean;
  infiniteScrollEnabled: boolean;
  pageOffset: number;
  frozenColumnCount?: number;
  columnAligns?: readonly ("left" | "right")[];
  columnTypeVisualKinds?: readonly DataGridTypeVisualKind[];
  colorizeDataTypes?: boolean;
  rightAlignedActionCell?: CanvasRightAlignedActionCell | null;
  booleanDisplayMode?: "checkbox" | "dropdown";
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

export interface CanvasBackingStoreMetrics {
  pixelWidth: number;
  pixelHeight: number;
  scaleX: number;
  scaleY: number;
  measured: boolean;
}

export function resolveCanvasBackingStoreMetrics(options: { width: number; height: number; pixelRatio: number; devicePixelSize?: CanvasDevicePixelSize | null }): CanvasBackingStoreMetrics {
  const width = Math.max(1, options.width);
  const height = Math.max(1, options.height);
  const fallbackRatio = Math.min(MAX_CANVAS_DATA_GRID_PIXEL_RATIO, Math.max(1, options.pixelRatio));
  const measured = options.devicePixelSize;
  const measurementMatches = !!measured && Math.abs(measured.cssWidth - width) <= 0.5 && Math.abs(measured.cssHeight - height) <= 0.5 && measured.pixelWidth > 0 && measured.pixelHeight > 0;
  const fallbackPixelWidth = Math.max(1, Math.ceil(width * fallbackRatio));
  const fallbackPixelHeight = Math.max(1, Math.ceil(height * fallbackRatio));
  const maxPixelWidth = Math.max(1, Math.ceil(width * MAX_CANVAS_DATA_GRID_PIXEL_RATIO));
  const maxPixelHeight = Math.max(1, Math.ceil(height * MAX_CANVAS_DATA_GRID_PIXEL_RATIO));
  const pixelWidth = measurementMatches ? Math.min(measured.pixelWidth, maxPixelWidth) : fallbackPixelWidth;
  const pixelHeight = measurementMatches ? Math.min(measured.pixelHeight, maxPixelHeight) : fallbackPixelHeight;
  return {
    pixelWidth,
    pixelHeight,
    scaleX: pixelWidth / width,
    scaleY: pixelHeight / height,
    measured: measurementMatches,
  };
}

export function resolveCanvasDataGridRowFill(theme: Pick<DataGridPaintTheme, "cellActive" | "cellSelected">, rowBase: string, options: { isActive: boolean; isDeleted: boolean; isSelected: boolean }): string {
  if (options.isSelected) return theme.cellSelected;
  if (options.isActive && !options.isDeleted) return theme.cellActive;
  return rowBase;
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

export function fitCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, align: "left" | "right" = "left"): string {
  if (maxWidth <= 0) return "";
  const font = ctx.font;
  const cacheKey = `${font}|${text}|${maxWidth}|${align}`;
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
    const candidate = align === "right" ? text.slice(text.length - mid) : text.slice(0, mid);
    if (ctx.measureText(candidate).width + ellipsisWidth <= maxWidth) low = mid;
    else high = mid - 1;
  }
  const result = align === "right" ? ellipsis + text.slice(text.length - low) : text.slice(0, low) + ellipsis;
  if (fitCanvasTextCache.size >= FIT_CANVAS_TEXT_CACHE_MAX) fitCanvasTextCache.clear();
  fitCanvasTextCache.set(cacheKey, result);
  return result;
}

export function canvasDataGridActionReservedWidth(canQuickDownload: boolean, canNavigateForeignKey = false): number {
  return canvasDataGridActionOverlayWidth(canQuickDownload, canNavigateForeignKey) + 6;
}

/** 悬浮按钮组宽度：每个按钮 20px + 2px 间距（detail 按钮始终存在） */
export function canvasDataGridActionOverlayWidth(canQuickDownload: boolean, canNavigateForeignKey = false): number {
  return 22 + (canQuickDownload ? 22 : 0) + (canNavigateForeignKey ? 22 : 0);
}

export function resolveCanvasCellTextLayout(options: { drawX: number; colWidth: number; dpr: number; isRightAlign: boolean; reservedWidth?: number }): { textAnchorX: number; maxWidth: number } {
  const reservedWidth = options.isRightAlign ? Math.max(0, options.reservedWidth ?? 0) : 0;
  return {
    textAnchorX: alignCanvasPixel(options.isRightAlign ? options.drawX + options.colWidth - 12 - reservedWidth : options.drawX + 12, options.dpr),
    maxWidth: Math.max(0, options.colWidth - 24 - reservedWidth),
  };
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

function drawBooleanCheckbox(ctx: CanvasRenderingContext2D, options: { drawX: number; y: number; colWidth: number; scaleX: number; scaleY: number; theme: DataGridPaintTheme; checked: boolean }): void {
  const { drawX, y, colWidth, scaleX, scaleY, theme, checked } = options;
  const size = BOOLEAN_CHECKBOX_SIZE;
  const boxX = alignCanvasPixel(drawX + (colWidth - size) / 2, scaleX);
  const boxY = alignCanvasPixel(y + (CANVAS_DATA_GRID_ROW_HEIGHT - size) / 2, scaleY);
  ctx.lineWidth = 1;
  if (checked) {
    ctx.fillStyle = theme.primary;
    ctx.fillRect(boxX, boxY, size, size);
    ctx.strokeStyle = theme.background;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(boxX + 3, boxY + size / 2);
    ctx.lineTo(boxX + size / 2 - 0.5, boxY + size - 3.5);
    ctx.lineTo(boxX + size - 2.5, boxY + 3);
    ctx.stroke();
    ctx.lineWidth = 1;
  } else {
    ctx.strokeStyle = theme.mutedForeground;
    ctx.strokeRect(boxX + 0.5, boxY + 0.5, size - 1, size - 1);
  }
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
    columnPreviewOffsets = [],
    columnPreviewSourceVisibleIndex,
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
    selectionFrames = [],
    cellCanHover,
    infiniteScrollEnabled,
    pageOffset,
    frozenColumnCount = 0,
    columnAligns,
    columnTypeVisualKinds,
    colorizeDataTypes = false,
    rightAlignedActionCell,
    columnIsBoolean,
    booleanDisplayMode = "dropdown",
  } = options;
  // 框选热路径：整次绘制只判断一次。常见情况（单矩形 / 多列且每段都是多格）可跳过逐格 kind 查询
  const paintSelectionOuterFrame = dataGridSelectionUsesOuterFrame(selectionFrames);
  const suppressAllSelectedCellBorders = selectionFrames.length > 0 && selectionFrames.every(dataGridFrameIsMultiCell);
  const selectionRowCoverage = selectionFrames.length > 0;
  const fallbackRatio = Math.max(1, options.pixelRatio ?? window.devicePixelRatio ?? 1);
  const { pixelWidth, pixelHeight, scaleX, scaleY } = resolveCanvasBackingStoreMetrics({
    width,
    height,
    pixelRatio: fallbackRatio,
    devicePixelSize: options.devicePixelSize,
  });
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
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
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
  let maxPreviewRightShift = 0;
  let maxPreviewLeftShift = 0;
  for (const offset of columnPreviewOffsets) {
    if (offset > maxPreviewRightShift) maxPreviewRightShift = offset;
    else if (-offset > maxPreviewLeftShift) maxPreviewLeftShift = -offset;
  }
  const contentStart = Math.max(0, scrollLeft - rowNumberWidth);
  const firstCol = firstVisibleColumn(offsets, Math.max(0, contentStart - maxPreviewRightShift));
  const columnOffset = offsets[firstCol] ?? 0;
  const paintSearchMatches = !isScrolling && searchMatchKeys.size > 0;
  const rowNumberBorderX = crispCanvasLine(rowNumberWidth - 1, scaleX);
  const rowNumberTextX = alignCanvasPixel(Math.max(0, rowNumberWidth - 1) / 2, scaleX);
  const rowTextOffsetY = alignCanvasPixel(CANVAS_DATA_GRID_ROW_HEIGHT / 2, scaleY);

  for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
    const item = rowAt(rowIndex);
    if (!item) continue;
    const y = rowIndex * CANVAS_DATA_GRID_ROW_HEIGHT - scrollTop;
    const rowIsActive = isRowActive(item.displayIndex);
    const rowSelectionVisual = rowCellsUseSelectionVisual(item.id);

    const rowBase = item.isDeleted ? theme.rowDeleted : item.isNew && !rowIsActive ? theme.rowNew : item.isDraft && !rowIsActive ? theme.rowMuted : item.displayIndex % 2 === 1 && !rowIsActive ? theme.rowMuted : theme.background;
    const rowFill = resolveCanvasDataGridRowFill(theme, rowBase, {
      isActive: rowIsActive,
      isDeleted: item.isDeleted,
      isSelected: rowSelectionVisual,
    });
    const rowBorderY = crispCanvasLine(y + CANVAS_DATA_GRID_ROW_HEIGHT - 1, scaleY);
    ctx.globalAlpha = item.isDeleted ? 0.7 : 1;
    ctx.fillStyle = rowFill;
    ctx.fillRect(0, y, width, CANVAS_DATA_GRID_ROW_HEIGHT);

    // 选区覆盖指示（Navicat 风格）：行落在选区范围内时行号淡色高亮；
    // 优先级低于行选中/状态色/活动行，与 DOM 的级联顺序一致
    const rowInSelection = !rowSelectionVisual && selectionRowCoverage && dataGridFrameCoversRow(selectionFrames, item.displayIndex);
    const rowNumberFill = rowSelectionVisual
      ? theme.rowNumberSelected
      : item.status === "draft"
        ? theme.rowNumberDefault
        : item.status === "new"
          ? theme.rowNumberNew
          : item.status === "edited"
            ? theme.rowNumberEdited
            : item.status === "deleted"
              ? theme.rowNumberDeleted
              : rowIsActive
                ? theme.rowNumberActive
                : rowInSelection
                  ? theme.cellSelected
                  : theme.rowNumberDefault;
    ctx.fillStyle = rowNumberFill;
    ctx.fillRect(0, y, rowNumberWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
    // 与 DOM 的 .data-grid-row-number--selected 对齐：选中行号左侧 3px 蓝色条
    if (rowSelectionVisual) {
      ctx.fillStyle = theme.cellSelectedBorder;
      ctx.fillRect(0, y, 3, CANVAS_DATA_GRID_ROW_HEIGHT);
    }
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(rowNumberBorderX, y);
    ctx.lineTo(rowNumberBorderX, y + CANVAS_DATA_GRID_ROW_HEIGHT);
    ctx.stroke();

    // 与 DOM 对齐：选中行号文字用前景色
    const rowNumberText = item.status === "new" ? theme.rowNumberTextNew : item.status === "edited" ? theme.rowNumberTextEdited : item.status === "deleted" ? theme.rowNumberTextDeleted : rowSelectionVisual ? theme.foreground : theme.rowNumberTextClean;
    ctx.fillStyle = rowNumberText;
    ctx.font = item.status === "new" || item.status === "edited" || item.status === "draft" ? semiboldFont : normalFont;
    ctx.textAlign = "center";
    const textY = alignCanvasPixel(y + rowTextOffsetY, scaleY);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, rowNumberWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
    ctx.clip();
    if (item.isDraft) {
      ctx.fillText("*", rowNumberTextX, textY);
    } else if (infiniteScrollEnabled) {
      ctx.fillText(String(item.displayIndex + 1), rowNumberTextX, textY);
    } else {
      ctx.fillText(String(item.displayIndex + 1 + pageOffset), rowNumberTextX, textY);
    }
    ctx.restore();
    ctx.font = normalFont;

    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(0, rowBorderY);
    ctx.lineTo(width, rowBorderY);
    ctx.stroke();
    const drawCell = (visibleColIdx: number, baseX: number) => {
      const colWidth = renderedColumnWidths[visibleColIdx] ?? 0;
      const actualColIdx = visibleColumnIndexes[visibleColIdx];
      if (actualColIdx === undefined) return;
      const drawX = baseX + (columnPreviewOffsets[visibleColIdx] ?? 0);
      if (drawX + colWidth < rowNumberWidth || drawX >= width) return;

      const selectedCell = cellIsSelected(item.displayIndex, visibleColIdx);
      const isDirtyCell = item.isDirtyCol[actualColIdx];
      const selectedFillVisual = rowSelectionVisual || selectedCell;
      // Navicat 风格：多格范围内部零描边（末尾统一画外框）；单格 / Ctrl 点选保留细边框
      const selectedBorderVisual = !selectedCell ? false : suppressAllSelectedCellBorders ? false : paintSelectionOuterFrame ? dataGridSelectionFrameKindAtCell(selectionFrames, item.displayIndex, visibleColIdx) !== "range" : true;
      const isSearchMatch = paintSearchMatches && searchMatchKeys.has(dataGridSearchMatchKey(item.displayIndex, actualColIdx));
      const isCurrentSearchMatch = paintSearchMatches && currentSearchMatch?.displayRow === item.displayIndex && currentSearchMatch.col === actualColIdx;
      const clippedX = Math.max(drawX, rowNumberWidth);
      const cellPaintWidth = Math.min(width, drawX + colWidth) - clippedX;
      if (cellPaintWidth <= 0) return;

      if (isDirtyCell && !selectedFillVisual) {
        ctx.fillStyle = theme.cellDirty;
        ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
      }
      if (hoverCell?.rowIndex === item.displayIndex && hoverCell.visibleColIdx === visibleColIdx && !isScrolling && !isSearchMatch && !isCurrentSearchMatch && !isDirtyCell && cellCanHover(item, actualColIdx)) {
        ctx.fillStyle = theme.cellHover;
        ctx.fillRect(clippedX, y, cellPaintWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
      }
      if (selectedCell && !item.isDeleted && !isDirtyCell) {
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
      const isBooleanCell = columnIsBoolean?.(actualColIdx) === true && isBooleanCellValue(value);
      const isRightAlign = columnAligns?.[visibleColIdx] === "right";
      const isEditingThisCell = editingCell?.rowId === item.id && editingCell.col === actualColIdx;
      const isBooleanNullCell = booleanDisplayMode === "checkbox" && isBooleanCell && value === null && !isEditingThisCell;
      const shouldRenderBooleanCheckbox = booleanDisplayMode === "checkbox" && isBooleanCell && value !== null && !isEditingThisCell;
      const typeKind = columnTypeVisualKinds?.[visibleColIdx] ?? "unknown";
      const textRole = resolveDataGridCellTextRole({
        colorizeTypes: colorizeDataTypes,
        typeKind,
        isNull: value === null,
        isDraft: item.isDraft && value === null,
        isEditing: isEditingThisCell,
        isControl: shouldRenderBooleanCheckbox,
        isSelected: selectedFillVisual,
        isCurrentSearchMatch,
        isSearchMatch,
        isDirty: isDirtyCell,
        isDeleted: item.isDeleted,
      });
      const cellTextColor = textRole === "muted" ? theme.mutedForeground : textRole === "type" ? dataGridTypeForeground(theme, typeKind) : theme.foreground;
      ctx.textAlign = isBooleanNullCell ? "center" : isRightAlign ? "right" : "left";
      ctx.fillStyle = cellTextColor;
      ctx.font = value === null ? italicFont : tabularFont;
      setCanvasNumericVariant(ctx, value === null ? "normal" : "tabular-nums");
      const reservedWidth = rightAlignedActionCell?.rowIndex === item.displayIndex && rightAlignedActionCell.visibleColIdx === visibleColIdx ? rightAlignedActionCell.reservedWidth : 0;
      const { textAnchorX, maxWidth: cellMaxWidth } = resolveCanvasCellTextLayout({ drawX, colWidth, dpr: scaleX, isRightAlign, reservedWidth });
      if (shouldRenderBooleanCheckbox) {
        drawBooleanCheckbox(ctx, { drawX, y, colWidth, scaleX, scaleY, theme, checked: normalizeBooleanCellValue(value) === true });
        if (item.isDeleted) {
          const boxX = alignCanvasPixel(drawX + (colWidth - BOOLEAN_CHECKBOX_SIZE) / 2, scaleX);
          const strikeY = alignCanvasPixel(y + CANVAS_DATA_GRID_ROW_HEIGHT / 2, scaleY);
          ctx.strokeStyle = cellTextColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(boxX - 1, strikeY);
          ctx.lineTo(alignCanvasPixel(boxX + BOOLEAN_CHECKBOX_SIZE + 1, scaleX), strikeY);
          ctx.stroke();
        }
      } else {
        const rawDisplayText = item.isDraft && value === null ? (draftCellPlaceholder ?? "") : formatCell(value, actualColIdx);
        const displayText = isEditingThisCell ? "" : firstLineCellDisplayValue(rawDisplayText);
        const text = isEditingThisCell ? displayText : fitCanvasText(ctx, displayText, cellMaxWidth, isBooleanNullCell ? "left" : isRightAlign ? "right" : "left");
        const anchorX = isBooleanNullCell ? alignCanvasPixel(drawX + colWidth / 2, scaleX) : textAnchorX;
        ctx.fillText(text, anchorX, textY);
        if (item.isDeleted && text) {
          const textWidth = ctx.measureText(text).width;
          const lineStartX = isBooleanNullCell ? anchorX - textWidth / 2 : isRightAlign ? textAnchorX - textWidth : textAnchorX;
          ctx.strokeStyle = cellTextColor;
          ctx.beginPath();
          ctx.moveTo(lineStartX, textY);
          ctx.lineTo(alignCanvasPixel(lineStartX + textWidth, scaleX), textY);
          ctx.stroke();
        }
      }
      ctx.restore();
      setCanvasNumericVariant(ctx, "normal");
      ctx.font = normalFont;

      ctx.strokeStyle = theme.border;
      ctx.beginPath();
      const columnBorderX = crispCanvasLine(drawX + colWidth - 1, scaleX);
      ctx.moveTo(columnBorderX, y);
      ctx.lineTo(columnBorderX, y + CANVAS_DATA_GRID_ROW_HEIGHT);
      ctx.stroke();

      if (selectedBorderVisual && cellPaintWidth >= 2) {
        const selectedLeftX = clippedX + 0.5;
        const selectedRightX = clippedX + cellPaintWidth - 1.5;
        const selectedTopY = Math.max(y + 0.5, 1);
        const drawSelectedLeftBorder = selectedLeftX >= rowNumberWidth + 0.5;
        ctx.strokeStyle = theme.cellSelectedSingleBorder;
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
    };

    // 第一轮：绘制非冻结列（跳过冻结列，冻结列稍后绘制以确保覆盖在上方）
    let x = rowNumberWidth + columnOffset - scrollLeft;
    for (let visibleColIdx = firstCol; visibleColIdx < renderedColumnWidths.length && x - maxPreviewLeftShift < width; visibleColIdx++) {
      if (visibleColIdx < frozenColumnCount) {
        x += renderedColumnWidths[visibleColIdx] ?? 0;
        continue;
      }
      const colWidth = renderedColumnWidths[visibleColIdx] ?? 0;
      drawCell(visibleColIdx, x);
      x += colWidth;
    }
    if (columnPreviewSourceVisibleIndex !== null && columnPreviewSourceVisibleIndex !== undefined && (columnPreviewOffsets[columnPreviewSourceVisibleIndex] ?? 0) !== 0) {
      drawCell(columnPreviewSourceVisibleIndex, rowNumberWidth + (offsets[columnPreviewSourceVisibleIndex] ?? 0) - scrollLeft);
    }
    // 第二轮：绘制冻结列（不受水平滚动影响，覆盖在非冻结列之上）
    if (frozenColumnCount > 0 && frozenColumnCount <= renderedColumnWidths.length) {
      const frozenWidth = offsets[frozenColumnCount] ?? 0;
      // 用不透明底色覆盖冻结区域（遮挡第一轮溢入的非冻结列内容）
      // 注意：rowBase 在浅色主题下可能是 color-mix(..., transparent) 半透明色，
      // 单次半透明填充无法遮挡文字，需先填不透明底再叠加半透明色调
      ctx.fillStyle = theme.background;
      ctx.fillRect(rowNumberWidth, y, frozenWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
      if (rowFill !== theme.background) {
        ctx.fillStyle = rowFill;
        ctx.fillRect(rowNumberWidth, y, frozenWidth, CANVAS_DATA_GRID_ROW_HEIGHT);
      }
      // 绘制冻结列的每个单元格（x 坐标不受 scrollLeft 影响）
      for (let fcIdx = 0; fcIdx < frozenColumnCount; fcIdx++) {
        const cellX = rowNumberWidth + (offsets[fcIdx] ?? 0);
        drawCell(fcIdx, cellX);
      }
      // 重绘行底部边框（冻结区域部分）
      ctx.strokeStyle = theme.border;
      ctx.beginPath();
      ctx.moveTo(rowNumberWidth, rowBorderY);
      ctx.lineTo(rowNumberWidth + frozenWidth, rowBorderY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // 画冻结列分隔线（与 DOM 模式和列头一致：2px 灰色右边框）
  // DOM 的 border-right 右边缘对齐单元格右边缘，中心偏左 1px；
  // Canvas 的 stroke 以坐标点为中心，需左移 1px 使两者对齐
  if (frozenColumnCount > 0 && frozenColumnCount < renderedColumnWidths.length) {
    const frozenWidth = offsets[frozenColumnCount] ?? 0;
    const separatorX = rowNumberWidth + frozenWidth - 1;
    ctx.save();
    ctx.strokeStyle = "rgb(100, 116, 139)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(separatorX, 0);
    ctx.lineTo(separatorX, height);
    ctx.stroke();
    ctx.restore();
  }

  // 选区外框：多格范围选区画一圈主题色细外框（1.5px，比单格的 1px 略粗），
  // 内部零描边（Navicat 风格）；1×1 单格外框已由逐格细边框覆盖，这里跳过
  if (paintSelectionOuterFrame) {
    const frozenWidth = frozenColumnCount > 0 && frozenColumnCount <= renderedColumnWidths.length ? (offsets[frozenColumnCount] ?? 0) : 0;
    const frozenRight = rowNumberWidth + frozenWidth;
    // 列边缘的屏幕 x：冻结区内的边缘不随水平滚动，其余减去 scrollLeft
    const columnEdgeX = (edgeCol: number): number => {
      const offset = offsets[edgeCol] ?? 0;
      return edgeCol <= frozenColumnCount ? rowNumberWidth + offset : rowNumberWidth + offset - scrollLeft;
    };
    ctx.save();
    ctx.strokeStyle = theme.cellSelectedSingleBorder;
    ctx.lineWidth = 1.5;
    for (const frame of selectionFrames) {
      if (!dataGridFrameIsMultiCell(frame)) continue;
      const minX = frame.startCol >= frozenColumnCount ? frozenRight : rowNumberWidth;
      const minRightX = frame.endCol + 1 > frozenColumnCount ? frozenRight : rowNumberWidth;
      const left = Math.min(Math.max(columnEdgeX(frame.startCol), minX), width);
      const right = Math.min(Math.max(columnEdgeX(frame.endCol + 1), minRightX), width);
      const top = Math.min(Math.max(frame.startRow * CANVAS_DATA_GRID_ROW_HEIGHT - scrollTop, 0), height);
      const bottom = Math.min(Math.max((frame.endRow + 1) * CANVAS_DATA_GRID_ROW_HEIGHT - scrollTop, 0), height);
      if (right - left < 2 || bottom - top < 2) continue;
      ctx.strokeRect(left + 1, top + 1, right - left - 2, bottom - top - 2);
    }
    ctx.restore();
  }
}
