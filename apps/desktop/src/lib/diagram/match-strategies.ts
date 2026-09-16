import type { DiagramTable } from "./erDiagram";

const TYPE_COMPATIBLE_MAP: Record<string, string[]> = {
  bigint: ["bigint", "int", "smallint", "tinyint", "integer", "long"],
  int: ["int", "bigint", "smallint", "tinyint", "integer"],
  smallint: ["smallint", "int", "bigint", "tinyint"],
  tinyint: ["tinyint", "smallint", "int", "bigint"],
  integer: ["integer", "int", "bigint", "smallint"],
  uuid: ["uuid", "char", "varchar", "nvarchar", "uniqueidentifier", "guid"],
  char: ["char", "varchar", "uuid", "uniqueidentifier"],
  varchar: ["varchar", "char", "uuid", "uniqueidentifier"],
  nvarchar: ["nvarchar", "varchar", "char", "uuid"],
  uniqueidentifier: ["uniqueidentifier", "uuid", "char", "varchar"],
};

export function isTypeCompatible(sourceType: string, targetType: string): boolean {
  const source = sourceType.toLowerCase();
  const target = targetType.toLowerCase();

  if (source === target) return true;

  const compatibleWithSource = TYPE_COMPATIBLE_MAP[source];
  if (compatibleWithSource && compatibleWithSource.includes(target)) {
    return true;
  }

  const compatibleWithTarget = TYPE_COMPATIBLE_MAP[target];
  if (compatibleWithTarget && compatibleWithTarget.includes(source)) {
    return true;
  }

  return false;
}

export function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export interface PrimaryKeyInfo {
  name: string;
  data_type: string;
}

export function buildPrimaryKeyIndex(tables: DiagramTable[]): Map<string, PrimaryKeyInfo> {
  const index = new Map<string, PrimaryKeyInfo>();

  for (const table of tables) {
    const pk = table.columns.find((col) => col.is_primary_key);
    if (pk) {
      index.set(table.name, { name: pk.name, data_type: pk.data_type });
    }
  }

  return index;
}

export function extractTableNameFromColumn(columnName: string): string | null {
  const camelCaseMatch = columnName.match(/^(.+?)(?:ID|UID)$/);
  if (camelCaseMatch) return camelCaseMatch[1];

  const underscoreMatch = columnName.match(/^(.+?)_(?:id|uuid|pk)$/i);
  if (underscoreMatch) return underscoreMatch[1];

  const lowercaseMatch = columnName.match(/^(.+?)(?:id|uid)$/i);
  if (lowercaseMatch) return lowercaseMatch[1];

  return null;
}
