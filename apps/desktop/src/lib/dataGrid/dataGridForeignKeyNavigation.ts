import type { NavigationTarget } from "@/composables/useNavigationTargets";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { ForeignKeyInfo } from "@/types/database";

/** 列名（小写）→ 外键。复合外键（同 name 多条记录）按列各自导航（v1）；
 * 同列出现在多个外键时保留第一条。 */
export function buildColumnForeignKeyMap(foreignKeys: ForeignKeyInfo[]): Map<string, ForeignKeyInfo> {
  const map = new Map<string, ForeignKeyInfo>();
  for (const fk of foreignKeys) {
    if (!fk.column || !fk.ref_table || !fk.ref_column) continue;
    const key = fk.column.toLowerCase();
    if (!map.has(key)) map.set(key, fk);
  }
  return map;
}

/** NULL/undefined 没有可跳转的目标记录；0、空串、false 都是合法外键值 */
export function foreignKeyCellNavigable(value: CellValue | undefined): boolean {
  return value !== null && value !== undefined;
}

/** 构建跳转到被引用表的导航目标：ref_schema 缺失时回退当前 schema（同 ER 图） */
export function foreignKeyNavigationTarget(options: { connectionId: string; database: string; currentSchema?: string; fk: ForeignKeyInfo; whereInput?: string }): NavigationTarget {
  const schema = options.fk.ref_schema || options.currentSchema || undefined;
  return {
    connectionId: options.connectionId,
    database: options.database,
    schema,
    tableName: options.fk.ref_table,
    columnName: options.fk.ref_column,
    whereInput: options.whereInput,
  };
}
