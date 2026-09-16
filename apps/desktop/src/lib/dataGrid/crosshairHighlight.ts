import type { CellPosition } from "@/lib/dataGrid/gridSelection";

/**
 * 行列十字高亮目标。只解析「原始选择状态」，不做转置投影（转置是纯展示层映射，
 * 由 DataGrid 在渲染时把 x/y 轴互换）。供 Canvas / 常规 DOM / 转置 DOM 三个渲染分支共享。
 *
 * 坐标约定：
 * - rowIndex 为原始行（displayIndex）；
 * - visibleColIdx 为可见列下标（selectionFocus.colIndex 语义，与 cellIsSelected 一致）；
 * - actualColIdx 为 visibleColumnIndexes[visibleColIdx] 对应的真实列下标。
 */
export interface CrosshairTarget {
  rowIndex: number; // 原始行（displayIndex）
  visibleColIdx: number; // selectionFocus.colIndex（可见列）
  actualColIdx: number; // visibleColumnIndexes[visibleColIdx]
  rowCrosshair: boolean; // 这一轴是否绘制（非"是否焦点格"）
  columnCrosshair: boolean;
}

export interface ResolveCrosshairTargetOptions {
  selectionFocus: CellPosition | null;
  selectionAnchor: CellPosition | null;
  hasRowSelection: boolean;
  hasColumnSelection: boolean;
  visibleColumnIndexes: readonly number[];
  /** 整行选中且无单元格焦点时派生行（DataGrid 从 lastClickedRowIndex / 首个 selectedRowId 推导） */
  fallbackRowIndex?: number | null;
  /** 整列选中且无单元格焦点时派生列（DataGrid 从首个 selectedColumnIndexes 推导） */
  fallbackColumnIndex?: number | null;
}

export function resolveCrosshairTarget(options: ResolveCrosshairTargetOptions): CrosshairTarget | null {
  const { selectionFocus, hasRowSelection, hasColumnSelection, visibleColumnIndexes } = options;

  if (selectionFocus) {
    const actualColIdx = visibleColumnIndexes[selectionFocus.colIndex];
    if (actualColIdx === undefined) return null;
    // 整行/整列选中会清空 focus（selectRow / selectColumns），因此普通格或多格范围
    // 的 focus 必不与其他整行/整列选中并存；但防御性处理：若共存，只亮对应轴。
    const rowCrosshair = !hasColumnSelection;
    const columnCrosshair = !hasRowSelection;
    return {
      rowIndex: selectionFocus.rowIndex,
      visibleColIdx: selectionFocus.colIndex,
      actualColIdx,
      rowCrosshair,
      columnCrosshair,
    };
  }

  // selectRow / handleRowClick 会调用 clearCellSelection() 清空 focus，整行选中时只能派生行。
  if (hasRowSelection) {
    if (options.fallbackRowIndex === null || options.fallbackRowIndex === undefined) return null;
    const actualColIdx = visibleColumnIndexes[0];
    if (actualColIdx === undefined) return null;
    return {
      rowIndex: options.fallbackRowIndex,
      visibleColIdx: 0,
      actualColIdx,
      rowCrosshair: true,
      columnCrosshair: false,
    };
  }

  // selectColumns 会清空 anchor/focus，整列选中时只能派生列。
  if (hasColumnSelection) {
    if (options.fallbackColumnIndex === null || options.fallbackColumnIndex === undefined) return null;
    const actualColIdx = visibleColumnIndexes[options.fallbackColumnIndex];
    if (actualColIdx === undefined) return null;
    return {
      rowIndex: 0,
      visibleColIdx: options.fallbackColumnIndex,
      actualColIdx,
      rowCrosshair: false,
      columnCrosshair: true,
    };
  }

  // 无焦点、加载中、空结果不绘制。
  return null;
}
