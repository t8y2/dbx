import type { NavigationTarget } from "@/composables/useNavigationTargets";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { ForeignKeyInfo } from "@/types/database";

export interface ForeignKeyAssociation {
  foreignKey: ForeignKeyInfo;
  columnPairs: ForeignKeyInfo[];
}

export interface ForeignKeyAssociationCell {
  foreignKey: ForeignKeyInfo;
  columnIndex: number;
  value: CellValue;
}

function foreignKeyAssociationKey(foreignKey: ForeignKeyInfo): string {
  return JSON.stringify([foreignKey.name, foreignKey.ref_schema ?? "", foreignKey.ref_table, foreignKey.on_update ?? "", foreignKey.on_delete ?? ""]);
}

/** 列名（小写）→ 外键 association。同列出现在多个 association 时保留第一条。 */
export function buildColumnForeignKeyMap(foreignKeys: ForeignKeyInfo[]): Map<string, ForeignKeyAssociation> {
  const associations = new Map<string, ForeignKeyAssociation>();
  for (const fk of foreignKeys) {
    if (!fk.column || !fk.ref_table || !fk.ref_column) continue;
    const associationKey = foreignKeyAssociationKey(fk);
    const association = associations.get(associationKey);
    if (association) association.columnPairs.push(fk);
    else associations.set(associationKey, { foreignKey: fk, columnPairs: [fk] });
  }

  const map = new Map<string, ForeignKeyAssociation>();
  for (const association of associations.values()) {
    for (const foreignKey of association.columnPairs) {
      const columnKey = foreignKey.column.toLowerCase();
      if (!map.has(columnKey)) map.set(columnKey, association);
    }
  }
  return map;
}

/** NULL/undefined 没有可跳转的目标记录；0、空串、false 都是合法外键值 */
export function foreignKeyCellNavigable(value: CellValue | undefined): value is Exclude<CellValue, null> {
  return value !== null && value !== undefined;
}

export function foreignKeySourceColumnName(options: { context?: "results" | "table-data"; resultColumns: readonly string[]; sourceColumns?: readonly (string | undefined)[]; columnIndex: number }): string | undefined {
  const sourceColumn = options.sourceColumns?.[options.columnIndex] || undefined;
  if (sourceColumn || options.context === "results") return sourceColumn;
  return options.resultColumns[options.columnIndex] || undefined;
}

export function foreignKeyAssociationCells(options: { association: ForeignKeyAssociation; context?: "results" | "table-data"; resultColumns: readonly string[]; sourceColumns?: readonly (string | undefined)[]; row: readonly (CellValue | undefined)[] }): ForeignKeyAssociationCell[] | undefined {
  const sourceColumnIndexes = new Map<string, number>();
  for (let columnIndex = 0; columnIndex < options.resultColumns.length; columnIndex += 1) {
    const sourceColumn = foreignKeySourceColumnName({
      context: options.context,
      resultColumns: options.resultColumns,
      sourceColumns: options.sourceColumns,
      columnIndex,
    });
    if (sourceColumn && !sourceColumnIndexes.has(sourceColumn.toLowerCase())) sourceColumnIndexes.set(sourceColumn.toLowerCase(), columnIndex);
  }

  const cells: ForeignKeyAssociationCell[] = [];
  for (const foreignKey of options.association.columnPairs) {
    const columnIndex = sourceColumnIndexes.get(foreignKey.column.toLowerCase());
    if (columnIndex === undefined) return undefined;
    const value = options.row[columnIndex];
    if (!foreignKeyCellNavigable(value)) return undefined;
    cells.push({ foreignKey, columnIndex, value });
  }
  return cells;
}

export function combineForeignKeyConditions(conditions: readonly (string | undefined)[]): string | undefined {
  if (conditions.length === 0 || conditions.some((condition) => !condition)) return undefined;
  if (conditions.length === 1) return conditions[0];
  return conditions.map((condition) => `(${condition})`).join(" AND ");
}

export function foreignKeyTableIdentity(options: { connectionId?: string; database?: string; catalog?: string; schema?: string; tableName?: string }): string | undefined {
  if (!options.connectionId || !options.tableName) return undefined;
  return JSON.stringify([options.connectionId, options.database ?? "", options.catalog ?? "", options.schema ?? "", options.tableName]);
}

export function foreignKeyMetadataRequestCurrent(options: { requestGeneration: number; currentGeneration: number; requestIdentity: string; currentIdentity?: string }): boolean {
  return options.requestGeneration === options.currentGeneration && options.requestIdentity === options.currentIdentity;
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
