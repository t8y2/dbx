import type { CellValue } from "@/lib/dataGrid/cellValue";

type RowLowerTextEntry = {
  /** 每列缓存时的源值引用：单元格被原地编辑后引用不再相等，仅重算该格 */
  values: CellValue[];
  lowers: (string | undefined)[];
};

/**
 * 搜索用小写文本缓存，按行数组身份挂 WeakMap：
 * - 工作集天然等于当前在内存中的结果行（行数组是 markRaw 的稳定引用），
 *   不存在固定容量 LRU 在全量顺序扫描下的零命中抖动，GC 自动回收旧结果；
 * - 展示格式化器/列类型变化时由调用方 clear() 整体失效。
 */
export function createRowLowerTextCache(format: (value: CellValue, columnIndex: number) => string) {
  let cache = new WeakMap<object, RowLowerTextEntry>();

  function get(rowData: CellValue[], columnIndex: number): string {
    let entry = cache.get(rowData);
    if (!entry) {
      entry = { values: [], lowers: [] };
      cache.set(rowData, entry);
    }
    const value = rowData[columnIndex];
    const cached = entry.lowers[columnIndex];
    if (cached !== undefined && Object.is(entry.values[columnIndex], value)) return cached;
    const lower = format(value, columnIndex).toLowerCase();
    entry.values[columnIndex] = value;
    entry.lowers[columnIndex] = lower;
    return lower;
  }

  function clear() {
    cache = new WeakMap<object, RowLowerTextEntry>();
  }

  return { get, clear };
}
