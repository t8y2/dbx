import type { IndexInfo } from "@/types/database";

/** 列的索引类型分类 */
export type ColumnIndexKind = "primary" | "unique" | "index" | "none";

/** 从索引列表构建列名 → 最高优先级索引类型的映射 */
export function buildColumnIndexMap(indexes: IndexInfo[]): Map<string, ColumnIndexKind> {
  const map = new Map<string, ColumnIndexKind>();
  for (const idx of indexes) {
    const kind: ColumnIndexKind = idx.is_primary ? "primary" : idx.is_unique ? "unique" : "index";
    for (const col of idx.columns) {
      const existing = map.get(col);
      if (!existing || columnIndexPriority(kind) > columnIndexPriority(existing)) {
        map.set(col, kind);
      }
    }
  }
  return map;
}

function columnIndexPriority(kind: ColumnIndexKind): number {
  switch (kind) {
    case "primary":
      return 3;
    case "unique":
      return 2;
    case "index":
      return 1;
    default:
      return 0;
  }
}

/** 索引类型对应的颜色类名（橙色=主键，红色=唯一，绿色=普通） */
export function columnIndexColorClass(kind: ColumnIndexKind): string {
  switch (kind) {
    case "primary":
      return "text-orange-500";
    case "unique":
      return "text-red-500";
    case "index":
      return "text-green-500";
    default:
      return "";
  }
}

/** 索引类型对应的 Tooltip 文本 */
export function columnIndexTooltip(kind: ColumnIndexKind): string {
  switch (kind) {
    case "primary":
      return "主键索引";
    case "unique":
      return "唯一索引";
    case "index":
      return "普通索引";
    default:
      return "";
  }
}
