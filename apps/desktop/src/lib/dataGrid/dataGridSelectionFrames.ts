import type { CellSelectionRange } from "@/lib/dataGrid/gridSelection";

/** 选区外框数据：把当前选区解析为一组连续矩形（frames）。
 * 只有能表示为连续矩形的选区才画外框（Navicat 风格：淡色填充 + 一圈外框）；
 * Ctrl 点选的离散单元格无法矩形化，返回 sparse，由调用方退回逐格描边。 */
export interface DataGridSelectionFrames {
  frames: CellSelectionRange[];
  sparse: boolean;
}

export function resolveDataGridSelectionFrames(options: { sparseCellCount: number; hasColumnSelection: boolean; selectedColumnIndexes: ReadonlySet<number>; selectedRange: CellSelectionRange | null; rowCount: number }): DataGridSelectionFrames {
  if (options.sparseCellCount > 0) return { frames: [], sparse: true };

  if (options.hasColumnSelection) {
    const lastRow = Math.max(0, options.rowCount - 1);
    const columns = [...options.selectedColumnIndexes].sort((a, b) => a - b);
    const frames: CellSelectionRange[] = [];
    let runStart = -1;
    let runEnd = -1;
    for (const col of columns) {
      if (runStart < 0) {
        runStart = col;
        runEnd = col;
        continue;
      }
      if (col === runEnd + 1) {
        runEnd = col;
        continue;
      }
      frames.push({ startRow: 0, endRow: lastRow, startCol: runStart, endCol: runEnd });
      runStart = col;
      runEnd = col;
    }
    if (runStart >= 0) frames.push({ startRow: 0, endRow: lastRow, startCol: runStart, endCol: runEnd });
    return { frames, sparse: false };
  }

  if (options.selectedRange) return { frames: [options.selectedRange], sparse: false };
  return { frames: [], sparse: false };
}

export function dataGridFrameContainsCell(frames: readonly CellSelectionRange[], rowIndex: number, colIndex: number): boolean {
  return dataGridFrameAtCell(frames, rowIndex, colIndex) !== null;
}

export function dataGridFrameAtCell(frames: readonly CellSelectionRange[], rowIndex: number, colIndex: number): CellSelectionRange | null {
  for (const frame of frames) {
    if (rowIndex >= frame.startRow && rowIndex <= frame.endRow && colIndex >= frame.startCol && colIndex <= frame.endCol) return frame;
  }
  return null;
}

export function dataGridFrameIsMultiCell(frame: CellSelectionRange): boolean {
  return frame.startRow !== frame.endRow || frame.startCol !== frame.endCol;
}

/** 行号的"选区覆盖"指示：行落在任一 frame 范围内即为被覆盖 */
export function dataGridFrameCoversRow(frames: readonly CellSelectionRange[], rowIndex: number): boolean {
  for (const frame of frames) {
    if (rowIndex >= frame.startRow && rowIndex <= frame.endRow) return true;
  }
  return false;
}

/** Navicat 风格的选区形态：单个单元格用细边框（single），
 * 多格范围用实心填充 + 文字反白（range），不在选区内返回 null。 */
export function dataGridSelectionFrameKindAtCell(frames: readonly CellSelectionRange[], rowIndex: number, colIndex: number): "single" | "range" | null {
  const frame = dataGridFrameAtCell(frames, rowIndex, colIndex);
  if (!frame) return null;
  return dataGridFrameIsMultiCell(frame) ? "range" : "single";
}

export interface DataGridSelectionEdgeFlags {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

/** 单元格在选区外框上的边：相邻格不在任何 frame 内的那一侧即为外框边。
 * 不在任何 frame 内时返回 null。 */
export function dataGridSelectionEdgeFlags(frames: readonly CellSelectionRange[], rowIndex: number, colIndex: number): DataGridSelectionEdgeFlags | null {
  if (frames.length === 0 || !dataGridFrameContainsCell(frames, rowIndex, colIndex)) return null;
  return {
    top: !dataGridFrameContainsCell(frames, rowIndex - 1, colIndex),
    right: !dataGridFrameContainsCell(frames, rowIndex, colIndex + 1),
    bottom: !dataGridFrameContainsCell(frames, rowIndex + 1, colIndex),
    left: !dataGridFrameContainsCell(frames, rowIndex, colIndex - 1),
  };
}
