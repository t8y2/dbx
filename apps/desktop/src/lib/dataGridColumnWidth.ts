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

function estimateTextWidth(text: string, padding: number): number {
  return text.length * DATA_GRID_CHAR_WIDTH + padding;
}

function displaySampleValue(value: CellValue): string | null {
  if (value == null) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function calculateDataGridColumnWidth(options: { columnName: string; sampleValues: readonly CellValue[]; maxWidth?: number; valueTextLimit?: number }): number {
  const maxAllowedWidth = options.maxWidth ?? DATA_GRID_COL_MAX_WIDTH;
  const valueTextLimit = options.valueTextLimit ?? DATA_GRID_VALUE_TEXT_LIMIT;
  let maxContentWidth = estimateTextWidth(options.columnName, DATA_GRID_HEADER_CONTROL_WIDTH);

  for (const value of options.sampleValues.slice(0, DATA_GRID_SAMPLE_ROWS)) {
    const text = displaySampleValue(value);
    if (text == null) continue;
    const displayLen = Math.min(text.length, valueTextLimit);
    const width = displayLen * DATA_GRID_CHAR_WIDTH + DATA_GRID_CELL_PADDING;
    if (width > maxContentWidth) maxContentWidth = width;
  }

  return Math.max(DATA_GRID_COL_MIN_WIDTH, Math.min(maxAllowedWidth, Math.round(maxContentWidth)));
}
