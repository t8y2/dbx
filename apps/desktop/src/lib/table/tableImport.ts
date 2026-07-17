import type { DatabaseType } from "@/types/database";

export const IMPORT_SKIP_TARGET = "";

export interface ImportColumnMappingLike {
  sourceColumn: string;
  targetColumn: string;
  targetDataType?: string | null;
}

export interface ImportMappingValidationResult {
  valid: boolean;
  errors: string[];
  duplicateTargets: string[];
}

export interface ImportTargetColumnLike {
  name: string;
  is_nullable?: boolean;
  column_default?: string | null;
  extra?: string | null;
  is_primary_key?: boolean;
}

export type TableImportWizardStep = "source" | "options" | "mapping" | "review" | "execution";

export const TABLE_IMPORT_WIZARD_STEPS: TableImportWizardStep[] = ["source", "options", "mapping", "review", "execution"];

export function normalizeImportColumnName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function autoMapImportColumns(sourceColumns: string[], targetColumns: string[]): Record<string, string> {
  const exactTargets = new Map(targetColumns.map((column) => [column, column]));
  const normalizedTargets = new Map(targetColumns.map((column) => [normalizeImportColumnName(column), column]));

  return Object.fromEntries(sourceColumns.map((source) => [source, exactTargets.get(source) ?? normalizedTargets.get(normalizeImportColumnName(source)) ?? IMPORT_SKIP_TARGET]));
}

export function validateImportMappings(mappings: ImportColumnMappingLike[]): ImportMappingValidationResult {
  const activeMappings = mappings.filter((mapping) => mapping.targetColumn.trim());
  const errors: string[] = [];
  const duplicateTargets: string[] = [];
  if (activeMappings.length === 0) {
    errors.push("No columns mapped for import");
  }

  const seen = new Set<string>();
  for (const mapping of activeMappings) {
    const key = mapping.targetColumn.trim().toLowerCase();
    if (seen.has(key) && !duplicateTargets.includes(mapping.targetColumn)) {
      duplicateTargets.push(mapping.targetColumn);
    }
    seen.add(key);
    if (Object.prototype.hasOwnProperty.call(mapping, "targetDataType") && !String(mapping.targetDataType || "").trim()) {
      errors.push(`Target data type cannot be empty: ${mapping.targetColumn}`);
    }
  }
  if (duplicateTargets.length) {
    errors.push(`Target column mapped more than once: ${duplicateTargets.join(", ")}`);
  }

  return { valid: errors.length === 0, errors, duplicateTargets };
}

export function requiredImportTargetColumns(columns: ImportTargetColumnLike[], mappedTargetColumns: string[]): string[] {
  const mapped = new Set(mappedTargetColumns.map((column) => column.toLowerCase()));
  return columns
    .filter((column) => !mapped.has(column.name.toLowerCase()))
    .filter(
      (column) =>
        column.is_nullable === false &&
        !column.column_default &&
        !String(column.extra || "")
          .toLowerCase()
          .includes("auto"),
    )
    .map((column) => column.name);
}

export function nextTableImportWizardStep(step: TableImportWizardStep): TableImportWizardStep {
  const index = TABLE_IMPORT_WIZARD_STEPS.indexOf(step);
  return TABLE_IMPORT_WIZARD_STEPS[Math.min(TABLE_IMPORT_WIZARD_STEPS.length - 1, Math.max(0, index) + 1)];
}

export function previousTableImportWizardStep(step: TableImportWizardStep): TableImportWizardStep {
  const index = TABLE_IMPORT_WIZARD_STEPS.indexOf(step);
  return TABLE_IMPORT_WIZARD_STEPS[Math.max(0, index - 1)];
}

type ImportInferredType = "boolean" | "integer" | "decimal" | "date" | "timestamp" | "json" | "text";

function hasNumericLeadingZero(value: string): boolean {
  const unsigned = value.trim().replace(/^[+-]/, "");
  return unsigned.length > 1 && unsigned[0] === "0" && /\d/.test(unsigned[1] || "");
}

function isLikelyDate(value: string): boolean {
  return /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(value.trim());
}

function isLikelyTimestamp(value: string): boolean {
  const trimmed = value.trim();
  return /^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed);
}

function inferStringType(value: string): ImportInferredType {
  const trimmed = value.trim();
  if (!trimmed) return "text";
  if (isLikelyTimestamp(trimmed)) return "timestamp";
  if (isLikelyDate(trimmed)) return "date";
  if (!hasNumericLeadingZero(trimmed)) {
    if (/^[+-]?\d+$/.test(trimmed)) return "integer";
    if (/^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+e[+-]?\d+|\d+\.\d*e[+-]?\d+|\d*\.\d+e[+-]?\d+)$/i.test(trimmed) && Number.isFinite(Number(trimmed))) {
      return "decimal";
    }
  }
  return "text";
}

function inferValueType(value: unknown): ImportInferredType | null {
  if (value == null) return null;
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "decimal";
  if (typeof value === "string") return inferStringType(value);
  if (typeof value === "object") return "json";
  return "text";
}

function mergeInferredType(current: ImportInferredType | null, next: ImportInferredType): ImportInferredType {
  if (!current || current === next) return next;
  if (current === "text" || next === "text") return "text";
  if ((current === "integer" && next === "decimal") || (current === "decimal" && next === "integer")) return "decimal";
  if ((current === "date" && next === "timestamp") || (current === "timestamp" && next === "date")) return "timestamp";
  return "text";
}

function inferColumnType(rows: unknown[][], sourceIndex: number): ImportInferredType {
  let inferred: ImportInferredType | null = null;
  for (const row of rows) {
    const valueType = inferValueType(row[sourceIndex]);
    if (!valueType) continue;
    inferred = mergeInferredType(inferred, valueType);
    if (inferred === "text") break;
  }
  return inferred || "text";
}

export function importDataTypeForDatabase(inferredType: ImportInferredType, databaseType?: DatabaseType): string {
  switch (inferredType) {
    case "boolean":
      if (["mysql", "doris", "starrocks", "goldendb", "sundb", "databend"].includes(databaseType || "")) return "TINYINT(1)";
      if (databaseType === "sqlserver") return "BIT";
      if (databaseType === "sqlite" || databaseType === "rqlite" || databaseType === "turso" || databaseType === "cloudflare-d1") return "INTEGER";
      if (databaseType === "oracle" || databaseType === "oceanbase-oracle" || databaseType === "dameng") return "NUMBER(1)";
      if (databaseType === "clickhouse") return "UInt8";
      return "BOOLEAN";
    case "integer":
      if (databaseType === "sqlite" || databaseType === "rqlite" || databaseType === "turso" || databaseType === "cloudflare-d1") return "INTEGER";
      if (databaseType === "oracle" || databaseType === "oceanbase-oracle" || databaseType === "dameng") return "NUMBER(19)";
      if (databaseType === "clickhouse") return "Int64";
      return "BIGINT";
    case "decimal":
      if (["postgres", "gaussdb", "opengauss", "redshift", "kingbase", "highgo", "kwdb", "vastbase"].includes(databaseType || "")) return "DOUBLE PRECISION";
      if (databaseType === "sqlite" || databaseType === "rqlite" || databaseType === "turso" || databaseType === "cloudflare-d1") return "REAL";
      if (databaseType === "oracle" || databaseType === "oceanbase-oracle" || databaseType === "dameng") return "BINARY_DOUBLE";
      if (databaseType === "clickhouse") return "Float64";
      return "DOUBLE";
    case "date":
      if (databaseType === "sqlite" || databaseType === "rqlite" || databaseType === "turso" || databaseType === "cloudflare-d1") return "TEXT";
      if (databaseType === "clickhouse") return "Date";
      return "DATE";
    case "timestamp":
      if (["mysql", "doris", "starrocks", "goldendb", "sundb", "databend"].includes(databaseType || "")) return "DATETIME";
      if (databaseType === "sqlserver") return "DATETIME2";
      if (databaseType === "sqlite" || databaseType === "rqlite" || databaseType === "turso" || databaseType === "cloudflare-d1") return "TEXT";
      if (databaseType === "clickhouse") return "DateTime64";
      return "TIMESTAMP";
    case "json":
      if (["postgres", "gaussdb", "opengauss", "kingbase", "highgo", "kwdb", "vastbase"].includes(databaseType || "")) return "JSONB";
      if (databaseType === "mysql" || databaseType === "databend") return "JSON";
      return importDataTypeForDatabase("text", databaseType);
    case "text":
    default:
      if (databaseType === "sqlserver") return "NVARCHAR(MAX)";
      if (databaseType === "oracle" || databaseType === "oceanbase-oracle" || databaseType === "dameng") return "CLOB";
      if (databaseType === "clickhouse") return "String";
      if (["hive", "trino", "prestosql", "databricks"].includes(databaseType || "")) return "STRING";
      return "TEXT";
  }
}

export function suggestImportTargetDataTypes(columns: string[], rows: unknown[][], databaseType?: DatabaseType): Record<string, string> {
  return Object.fromEntries(columns.map((column, index) => [column, importDataTypeForDatabase(inferColumnType(rows, index), databaseType)]));
}
