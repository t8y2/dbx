import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { ColumnInfo, ForeignKeyInfo } from "@/types/database";

/**
 * 外键资讯卡的取数：只查模板用到的列；`{{fk_column.column}}` 沿被引用表自己的外键
 * 再查一层（可继续 `a.b.c`，最多 FOREIGN_KEY_CARD_MAX_DEPTH 层），结果以点路径为键平铺。
 */

export interface ForeignKeyCardTableRef {
  schema: string;
  table: string;
}

export interface ForeignKeyCardRelation {
  /** 被引用表上的外键列，即模板路径的第一段。 */
  column: string;
  table: string;
  schema: string;
  columns: ColumnInfo[];
}

export interface ForeignKeyCardQueryDeps {
  columns(ref: ForeignKeyCardTableRef): Promise<ColumnInfo[]>;
  foreignKeys(ref: ForeignKeyCardTableRef): Promise<ForeignKeyInfo[]>;
  /** 构造 `<columnName> = <value>` 的 WHERE 条件。 */
  condition(ref: ForeignKeyCardTableRef, columnName: string, columnInfo: ColumnInfo | undefined, value: Exclude<CellValue, null>): Promise<string | undefined>;
  /** columns 为 undefined 时查整行。 */
  selectRow(ref: ForeignKeyCardTableRef, columns: string[] | undefined, whereInput: string): Promise<Record<string, CellValue> | undefined>;
}

export const FOREIGN_KEY_CARD_MAX_DEPTH = 3;
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** 模板中的占位符路径（按 `.` 拆分、去重，保持出现顺序）。 */
export function foreignKeyCardTemplatePaths(html: string): string[][] {
  const seen = new Set<string>();
  const paths: string[][] = [];
  for (const match of html.matchAll(PLACEHOLDER_PATTERN)) {
    const path = match[1].split(".").map((segment) => segment.trim());
    if (path.some((segment) => !segment)) continue;
    const key = path.join(".").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

/** 只认单列外键：复合外键没有唯一的「下一张表的那一行」。 */
function singleColumnForeignKeys(foreignKeys: readonly ForeignKeyInfo[]): Map<string, ForeignKeyInfo> {
  const counts = new Map<string, number>();
  for (const fk of foreignKeys) counts.set(fk.name, (counts.get(fk.name) ?? 0) + 1);
  const map = new Map<string, ForeignKeyInfo>();
  for (const fk of foreignKeys) {
    if (!fk.column || !fk.ref_table || !fk.ref_column || (fk.name && (counts.get(fk.name) ?? 0) > 1)) continue;
    const key = fk.column.toLowerCase();
    if (!map.has(key)) map.set(key, fk);
  }
  return map;
}

function childRef(ref: ForeignKeyCardTableRef, fk: ForeignKeyInfo): ForeignKeyCardTableRef {
  return { schema: fk.ref_schema || ref.schema, table: fk.ref_table };
}

function recordValue(record: Record<string, CellValue>, column: string): CellValue | undefined {
  if (column in record) return record[column];
  const lower = column.toLowerCase();
  const key = Object.keys(record).find((name) => name.toLowerCase() === lower);
  return key === undefined ? undefined : record[key];
}

/**
 * 按模板路径取一条记录。paths 为 undefined 时查整行（不展开关联）。
 * 找不到的列/外键静默忽略，占位符渲染为空，与未知列的处理一致。
 */
export async function loadForeignKeyCardRecord(ref: ForeignKeyCardTableRef, whereInput: string, paths: readonly string[][] | undefined, deps: ForeignKeyCardQueryDeps, depth = 0): Promise<Record<string, CellValue> | undefined> {
  if (!paths) return deps.selectRow(ref, undefined, whereInput);
  const columns = await deps.columns(ref);
  const byLower = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  const selected: string[] = [];
  const nested = new Map<string, { column: string; paths: string[][] }>();
  for (const path of paths) {
    const column = byLower.get(path[0].toLowerCase());
    if (!column) continue;
    if (!selected.includes(column.name)) selected.push(column.name);
    if (path.length > 1 && depth + 1 < FOREIGN_KEY_CARD_MAX_DEPTH) {
      const group = nested.get(column.name.toLowerCase()) ?? { column: column.name, paths: [] };
      group.paths.push(path.slice(1));
      nested.set(column.name.toLowerCase(), group);
    }
  }
  // 模板没有引用任何真实列（纯静态内容或全是拼错的列）：退回整行，保证卡片仍能判断记录是否存在。
  const record = await deps.selectRow(ref, selected.length ? selected : undefined, whereInput);
  if (!record || !nested.size) return record;

  const foreignKeys = singleColumnForeignKeys(await deps.foreignKeys(ref));
  const merged: Record<string, CellValue> = { ...record };
  await Promise.all(
    [...nested.values()].map(async (group) => {
      const fk = foreignKeys.get(group.column.toLowerCase());
      const value = recordValue(record, group.column);
      if (!fk || value === null || value === undefined) return;
      const target = childRef(ref, fk);
      const targetColumns = await deps.columns(target);
      const condition = await deps.condition(
        target,
        fk.ref_column,
        targetColumns.find((column) => column.name.toLowerCase() === fk.ref_column.toLowerCase()),
        value,
      );
      if (!condition) return;
      const child = await loadForeignKeyCardRecord(target, condition, group.paths, deps, depth + 1);
      if (!child) return;
      for (const [key, childValue] of Object.entries(child)) merged[`${group.column}.${key}`] = childValue;
    }),
  );
  return merged;
}

/** 被引用表上可展开的一层关联（供编辑器列出可插入的 `{{fk.column}}`，也交给 AI）。 */
export async function loadForeignKeyCardRelations(ref: ForeignKeyCardTableRef, deps: Pick<ForeignKeyCardQueryDeps, "columns" | "foreignKeys">): Promise<ForeignKeyCardRelation[]> {
  const foreignKeys = [...singleColumnForeignKeys(await deps.foreignKeys(ref)).values()];
  const relations = await Promise.all(
    foreignKeys.map(async (fk) => {
      const target = childRef(ref, fk);
      try {
        return { column: fk.column, table: target.table, schema: target.schema, columns: await deps.columns(target) };
      } catch {
        return null;
      }
    }),
  );
  return relations.filter((relation): relation is ForeignKeyCardRelation => !!relation);
}

/** 编辑器预览用：本表所有列 + 每个一层关联的所有列。 */
export function foreignKeyCardPreviewPaths(columns: readonly ColumnInfo[], relations: readonly ForeignKeyCardRelation[]): string[][] {
  return [...columns.map((column) => [column.name]), ...relations.flatMap((relation) => relation.columns.map((column) => [relation.column, column.name]))];
}
