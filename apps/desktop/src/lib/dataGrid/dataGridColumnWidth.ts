import type { ColumnWidthDensity } from "@/stores/settingsStore";

type CellValue = string | number | boolean | null;

export const DATA_GRID_COL_MIN_WIDTH = 60;
export const DATA_GRID_COL_MAX_WIDTH = 400;
export const DATA_GRID_COL_AUTO_FIT_MAX_WIDTH = 1200;
export const DATA_GRID_HEADER_MAX_WIDTH = 500;
export const DATA_GRID_CHAR_WIDTH = 8;
export const DATA_GRID_HEADER_CONTROL_WIDTH = 80;
export const DATA_GRID_CELL_PADDING = 28;
export const DATA_GRID_SAMPLE_ROWS = 50;
export const DATA_GRID_VALUE_TEXT_LIMIT = 60;
export const DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT = 160;

export interface ColumnWidthDensityPreset {
  charWidth: number;
  headerControlWidth: number;
  headerControlWidthCompact: number;
  cellPadding: number;
  valueTextLimit: number;
  maxWidth: number;
  sampleRows: number;
  // 采样值宽度百分位（0-100）。100=最大值，<100 忽略离群值实现自适应
  valueWidthPercentile: number;
}

export const COLUMN_WIDTH_DENSITY_PRESETS: Record<ColumnWidthDensity, ColumnWidthDensityPreset> = {
  compact: {
    // 紧凑：以字段名为基准。控件垂直堆叠 16px + padding 16px + gap 4px + border 1px = 37 + 渲染余量 8px = 45
    charWidth: 7,
    headerControlWidth: 45,
    headerControlWidthCompact: 45,
    cellPadding: 24,
    valueTextLimit: 20,
    maxWidth: 480,
    sampleRows: 30,
    valueWidthPercentile: 100,
  },
  standard: {
    // 标准：紧凑表头，减少固定开销
    // compactActions → 实际 57px + 2px 余量 = 59
    // 非 compactActions → 实际 81px + 2px 余量 = 83
    charWidth: 8,
    headerControlWidth: 83,
    headerControlWidthCompact: 59,
    cellPadding: 24,
    valueTextLimit: 40,
    maxWidth: 360,
    sampleRows: 50,
    valueWidthPercentile: 90,
  },
  comfortable: {
    // 宽松：展示更多内容，valueTextLimit=120 几乎不截断，maxWidth=600
    charWidth: 8,
    headerControlWidth: 83,
    headerControlWidthCompact: 59,
    cellPadding: 24,
    valueTextLimit: 120,
    maxWidth: 600,
    sampleRows: 50,
    valueWidthPercentile: 95,
  },
};

// 全角字符（CJK 等）按 2 倍宽度估算，确保中文字段名完整显示
function estimateTextWidth(text: string, padding: number, charWidth: number): number {
  let width = 0;
  for (const ch of text) {
    width += ch.codePointAt(0)! > 0x7e ? charWidth * 2 : charWidth;
  }
  return width + padding;
}

function displaySampleValue(value: CellValue): string | null {
  if (value == null) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// 取排序后第 percentile 百分位的值
export function percentileValue(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  // P100 must be independent of input order and does not require sorting.
  if (percentile >= 100) {
    let maximum = values[0];
    for (let index = 1; index < values.length; index++) maximum = Math.max(maximum, values[index]);
    return maximum;
  }
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length));
  return sorted[idx];
}

export function calculateDataGridColumnWidth(options: { columnName: string; sampleValues: readonly CellValue[]; maxWidth?: number; valueTextLimit?: number; density?: ColumnWidthDensity; compactColumnHeaderActions?: boolean; includeValues?: boolean; headerTextWidth?: number }): number {
  const density = options.density ?? "standard";
  const preset = COLUMN_WIDTH_DENSITY_PRESETS[density];
  const maxAllowedWidth = options.maxWidth ?? preset.maxWidth;
  const valueTextLimit = options.valueTextLimit ?? preset.valueTextLimit;
  const headerControl = options.compactColumnHeaderActions ? preset.headerControlWidthCompact : preset.headerControlWidth;
  const headerTextWidth = options.headerTextWidth ?? estimateTextWidth(options.columnName, 0, preset.charWidth);
  // Protect the grid from pathological identifiers while keeping normal names density-independent.
  const headerWidth = Math.min(DATA_GRID_HEADER_MAX_WIDTH, headerTextWidth + headerControl);

  // Density limits cell content, never the column name and its header controls.
  if (density === "compact" && !options.includeValues) {
    return Math.max(DATA_GRID_COL_MIN_WIDTH, Math.round(headerWidth));
  }

  const valueWidths: number[] = [];
  for (const value of options.sampleValues.slice(0, preset.sampleRows)) {
    const text = displaySampleValue(value);
    if (text == null) continue;
    const displayLen = Math.min(text.length, valueTextLimit);
    valueWidths.push(displayLen * preset.charWidth + preset.cellPadding);
  }

  const valueWidth = percentileValue(valueWidths, preset.valueWidthPercentile);
  const maxContentWidth = Math.max(headerWidth, Math.min(maxAllowedWidth, valueWidth));

  return Math.max(DATA_GRID_COL_MIN_WIDTH, Math.round(maxContentWidth));
}
