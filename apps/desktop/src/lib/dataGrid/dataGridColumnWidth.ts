import type { ColumnWidthDensity } from "@/stores/settingsStore";

type CellValue = string | number | boolean | null;

export const DATA_GRID_COL_MIN_WIDTH = 60;
export const DATA_GRID_COL_MAX_WIDTH = 400;
export const DATA_GRID_COL_AUTO_FIT_MAX_WIDTH = 1200;
export const DATA_GRID_CHAR_WIDTH = 8;
export const DATA_GRID_HEADER_CONTROL_WIDTH = 80;
export const DATA_GRID_CELL_PADDING = 28;
export const DATA_GRID_SAMPLE_ROWS = 50;
export const DATA_GRID_VALUE_TEXT_LIMIT = 60;
export const DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT = 160;

export interface ColumnWidthDensityPreset {
  charWidth: number;
  headerControlWidth: number;
  cellPadding: number;
  valueTextLimit: number;
  maxWidth: number;
  sampleRows: number;
  headerControlWidthCompact: number;
}

export const COLUMN_WIDTH_DENSITY_PRESETS: Record<ColumnWidthDensity, ColumnWidthDensityPreset> = {
  compact: {
    charWidth: 7,
    headerControlWidth: 36,
    headerControlWidthCompact: 20,
    cellPadding: 18,
    valueTextLimit: 30,
    maxWidth: 250,
    sampleRows: 30,
  },
  standard: {
    charWidth: 8,
    headerControlWidth: 80,
    headerControlWidthCompact: 80,
    cellPadding: 28,
    valueTextLimit: 60,
    maxWidth: 400,
    sampleRows: 50,
  },
  comfortable: {
    charWidth: 9,
    headerControlWidth: 96,
    headerControlWidthCompact: 96,
    cellPadding: 36,
    valueTextLimit: 80,
    maxWidth: 600,
    sampleRows: 50,
  },
};

function estimateTextWidth(text: string, padding: number, charWidth: number): number {
  return text.length * charWidth + padding;
}

function displaySampleValue(value: CellValue): string | null {
  if (value == null) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function calculateDataGridColumnWidth(options: { columnName: string; sampleValues: readonly CellValue[]; maxWidth?: number; valueTextLimit?: number; density?: ColumnWidthDensity; compactColumnHeaderActions?: boolean }): number {
  const density = options.density ?? "standard";
  const preset = COLUMN_WIDTH_DENSITY_PRESETS[density];
  const maxAllowedWidth = options.maxWidth ?? preset.maxWidth;
  const valueTextLimit = options.valueTextLimit ?? preset.valueTextLimit;
  const headerControl = options.compactColumnHeaderActions ? preset.headerControlWidthCompact : preset.headerControlWidth;
  let maxContentWidth = estimateTextWidth(options.columnName, headerControl, preset.charWidth);

  for (const value of options.sampleValues.slice(0, preset.sampleRows)) {
    const text = displaySampleValue(value);
    if (text == null) continue;
    const displayLen = Math.min(text.length, valueTextLimit);
    const width = displayLen * preset.charWidth + preset.cellPadding;
    if (width > maxContentWidth) maxContentWidth = width;
  }

  return Math.max(DATA_GRID_COL_MIN_WIDTH, Math.min(maxAllowedWidth, Math.round(maxContentWidth)));
}
