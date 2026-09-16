import type { IndexInfo } from "@/types/database";

/** 列的索引类型分类 */
export type ColumnIndexKind = "primary" | "unique" | "index" | "none";

export function columnIndexNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** 从主键和索引列表构建规范化列名 → 最高优先级索引类型的映射 */
export function buildColumnIndexMap(indexes: IndexInfo[], primaryKeyColumns: readonly string[] = []): Map<string, ColumnIndexKind> {
  const map = new Map<string, ColumnIndexKind>();
  for (const column of primaryKeyColumns) {
    const key = columnIndexNameKey(column);
    if (key) map.set(key, "primary");
  }
  for (const idx of indexes) {
    const kind: ColumnIndexKind = idx.is_primary ? "primary" : idx.is_unique ? "unique" : "index";
    for (const col of idx.columns) {
      const key = columnIndexNameKey(col);
      if (!key) continue;
      const existing = map.get(key);
      if (!existing || columnIndexPriority(kind) > columnIndexPriority(existing)) {
        map.set(key, kind);
      }
    }
  }
  return map;
}

export function columnIndexTableIdentity(options: { connectionId?: string; database?: string; catalog?: string; schema?: string; tableName?: string }): string | undefined {
  if (!options.connectionId || !options.tableName) return undefined;
  return JSON.stringify([options.connectionId, options.database ?? "", options.catalog ?? "", options.schema ?? "", options.tableName]);
}

export function columnIndexMetadataRequestCurrent(options: { requestGeneration: number; currentGeneration: number; requestIdentity: string; currentIdentity?: string }): boolean {
  return options.requestGeneration === options.currentGeneration && options.requestIdentity === options.currentIdentity;
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
