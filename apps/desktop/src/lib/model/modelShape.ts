import type { ColumnInfo, DatabaseType, TreeNode } from "@/types/database";

export type ModelScalarType = "string" | "integer" | "number" | "boolean" | "date" | "time" | "datetime" | "binary" | "json" | "uuid" | "unknown";

export interface DatabaseModelColumn {
  name: string;
  originalType: string;
  normalizedType: ModelScalarType;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue?: string | null;
  comment?: string | null;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
}

export interface DatabaseModelShape {
  tableName: string;
  schema?: string;
  tableComment?: string | null;
  databaseType?: DatabaseType;
  columns: DatabaseModelColumn[];
}

export function modelShapeFromTable(node: TreeNode, columns: ColumnInfo[], databaseType?: DatabaseType): DatabaseModelShape {
  return {
    tableName: node.label,
    schema: node.schema,
    tableComment: node.comment,
    databaseType,
    columns: columns.map((column) => ({
      name: column.name,
      originalType: column.data_type,
      normalizedType: normalizeModelScalarType(column.data_type),
      nullable: column.is_nullable,
      primaryKey: column.is_primary_key,
      defaultValue: column.column_default,
      comment: column.comment,
      length: column.character_maximum_length,
      precision: column.numeric_precision,
      scale: column.numeric_scale,
    })),
  };
}

export function normalizeModelScalarType(raw: string | null | undefined): ModelScalarType {
  const type = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const base = type.split("(")[0]?.trim() ?? type;
  if (/^(?:tiny|small|medium|big)?int(?:eger)?$/.test(base) || /^(?:serial|bigserial|smallserial)$/.test(base)) return "integer";
  if (/^(?:decimal|numeric|number|real|float|double|money|smallmoney)$/.test(base)) return "number";
  if (/^(?:bool|boolean|bit)$/.test(base)) return "boolean";
  if (/^(?:date)$/.test(base)) return "date";
  if (/^(?:time|timetz)$/.test(base)) return "time";
  if (/^(?:datetime|datetime2|smalldatetime|timestamp|timestamptz|timestamp with time zone|timestamp without time zone)$/.test(base)) return "datetime";
  if (/^(?:binary|varbinary|bytea|blob|tinyblob|mediumblob|longblob|image)$/.test(base)) return "binary";
  if (/^(?:json|jsonb|xml|hstore)$/.test(base)) return "json";
  if (/^(?:uuid|uniqueidentifier)$/.test(base)) return "uuid";
  if (/^(?:char|nchar|varchar|nvarchar|character|text|tinytext|mediumtext|longtext|citext|clob|nclob)$/.test(base)) return "string";
  return "unknown";
}

export function pascalCase(value: string): string {
  const result = value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return result || "GeneratedModel";
}

export function camelCase(value: string): string {
  const pascal = pascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function snakeCase(value: string): string {
  return (
    value
      .replace(/([a-z\d])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "field"
  );
}

export function safeIdentifier(value: string, fallback = "field"): string {
  const normalized = value.replace(/[^a-zA-Z0-9_$]/g, "_");
  const words = new Set(
    "class public private protected internal record struct interface enum type string int long float double bool boolean char byte short void new return default switch case for while do if else try catch finally throw throws import export package namespace using from as in is def pass async await lambda with yield global nonlocal None True False null true false self super this static const let var val fun object data when match move ref mut pub use mod crate impl trait fn loop where dyn unsafe final extends implements native synchronized volatile transient abstract assert break continue goto instanceof typeof delete function required init deinit operator protocol extension associatedtype any mixed get set".split(
      " ",
    ),
  );
  const candidate = /^[a-zA-Z_]/.test(normalized) ? normalized : `${fallback}_${normalized}`;
  return words.has(candidate) ? `${candidate}_field` : candidate;
}

export function commentLines(value: string | null | undefined, prefix: string): string[] {
  if (!value?.trim()) return [];
  return value.split(/\r?\n/).map(
    (line) =>
      `${prefix}${line
        .trim()
        .replace(/\*\//g, "* /")
        .replace(/\\u/gi, "u")
        .replace(/[\u2028\u2029]/g, " ")}`,
  );
}
