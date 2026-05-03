import type { ColumnInfo, DatabaseType, IndexInfo } from "../types/database.ts";

export interface EditableStructureColumn {
  id: string;
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string;
  comment: string;
  isPrimaryKey: boolean;
  original?: ColumnInfo;
  markedForDrop: boolean;
}

export interface EditableStructureIndex {
  id: string;
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  filter: string;
  indexType: string;
  includedColumns: string[];
  comment: string;
  original?: IndexInfo;
  markedForDrop: boolean;
}

export interface BuildTableStructureChangeSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  columns: EditableStructureColumn[];
  indexes: EditableStructureIndex[];
}

export interface TableStructureChangeSql {
  statements: string[];
  warnings: string[];
}

function quoteIdent(databaseType: DatabaseType | undefined, name: string): string {
  if (databaseType === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (databaseType === "sqlserver") return `[${name.replace(/\]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function qualifiedTable(databaseType: DatabaseType | undefined, schema: string | undefined, tableName: string): string {
  if ((databaseType === "postgres" || databaseType === "oracle" || databaseType === "sqlserver") && schema) {
    return `${quoteIdent(databaseType, schema)}.${quoteIdent(databaseType, tableName)}`;
  }
  return quoteIdent(databaseType, tableName);
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizeDefault(value: string | null | undefined): string {
  const trimmed = clean(value);
  return trimmed.toLowerCase() === "null" ? "" : trimmed;
}

function columnDefinition(databaseType: DatabaseType | undefined, column: EditableStructureColumn): string {
  const parts = [
    quoteIdent(databaseType, column.name),
    column.dataType.trim(),
  ];
  if (!column.isNullable) parts.push("NOT NULL");
  const defaultValue = normalizeDefault(column.defaultValue);
  if (defaultValue) parts.push(`DEFAULT ${defaultValue}`);
  if (databaseType === "mysql" && clean(column.comment)) {
    parts.push(`COMMENT ${quoteString(clean(column.comment))}`);
  }
  return parts.join(" ");
}

function originalDefault(column: EditableStructureColumn): string {
  return normalizeDefault(column.original?.column_default);
}

function originalComment(column: EditableStructureColumn): string {
  return clean(column.original?.comment);
}

function hasExistingColumnAttributeChange(column: EditableStructureColumn): boolean {
  const original = column.original;
  if (!original) return false;
  return (
    column.name !== original.name ||
    column.dataType.trim() !== original.data_type.trim() ||
    column.isNullable !== original.is_nullable ||
    normalizeDefault(column.defaultValue) !== originalDefault(column) ||
    clean(column.comment) !== originalComment(column)
  );
}

function buildAddColumnSql(
  databaseType: DatabaseType | undefined,
  table: string,
  column: EditableStructureColumn,
): string[] {
  const addKeyword = databaseType === "sqlserver" ? "ADD" : "ADD COLUMN";
  const statements = [
    `ALTER TABLE ${table} ${addKeyword} ${columnDefinition(databaseType, column)};`,
  ];
  if (databaseType === "postgres" && clean(column.comment)) {
    statements.push(`COMMENT ON COLUMN ${table}.${quoteIdent(databaseType, column.name)} IS ${quoteString(clean(column.comment))};`);
  }
  return statements;
}

function buildMysqlExistingColumnSql(table: string, column: EditableStructureColumn): string[] {
  const originalName = column.original?.name ?? column.name;
  const operation = column.name === originalName
    ? `MODIFY COLUMN ${columnDefinition("mysql", column)}`
    : `CHANGE COLUMN ${quoteIdent("mysql", originalName)} ${columnDefinition("mysql", column)}`;
  return [`ALTER TABLE ${table} ${operation};`];
}

function buildPostgresExistingColumnSql(table: string, column: EditableStructureColumn): string[] {
  const original = column.original;
  if (!original) return [];

  const statements: string[] = [];
  const currentName = column.name;
  if (column.name !== original.name) {
    statements.push(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent("postgres", original.name)} TO ${quoteIdent("postgres", column.name)};`);
  }
  if (column.dataType.trim() !== original.data_type.trim()) {
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${quoteIdent("postgres", currentName)} TYPE ${column.dataType.trim()};`);
  }
  if (column.isNullable !== original.is_nullable) {
    const action = column.isNullable ? "DROP NOT NULL" : "SET NOT NULL";
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${quoteIdent("postgres", currentName)} ${action};`);
  }
  if (normalizeDefault(column.defaultValue) !== originalDefault(column)) {
    const defaultValue = normalizeDefault(column.defaultValue);
    const action = defaultValue ? `SET DEFAULT ${defaultValue}` : "DROP DEFAULT";
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${quoteIdent("postgres", currentName)} ${action};`);
  }
  if (clean(column.comment) !== originalComment(column)) {
    const commentValue = clean(column.comment) ? quoteString(clean(column.comment)) : "NULL";
    statements.push(`COMMENT ON COLUMN ${table}.${quoteIdent("postgres", currentName)} IS ${commentValue};`);
  }
  return statements;
}

function buildSqliteExistingColumnSql(
  table: string,
  column: EditableStructureColumn,
  warnings: string[],
): string[] {
  const original = column.original;
  if (!original) return [];

  const statements: string[] = [];
  const unsupportedChange = (
    column.dataType.trim() !== original.data_type.trim() ||
    column.isNullable !== original.is_nullable ||
    normalizeDefault(column.defaultValue) !== originalDefault(column) ||
    clean(column.comment) !== originalComment(column)
  );
  if (column.name !== original.name) {
    statements.push(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent("sqlite", original.name)} TO ${quoteIdent("sqlite", column.name)};`);
  }
  if (unsupportedChange) {
    warnings.push(`SQLite cannot safely alter existing column "${original.name}" without rebuilding the table.`);
  }
  return statements;
}

function buildColumnSql(
  options: BuildTableStructureChangeSqlOptions,
  warnings: string[],
): string[] {
  const databaseType = options.databaseType;
  const table = qualifiedTable(databaseType, options.schema, options.tableName);
  const statements: string[] = [];

  for (const column of options.columns) {
    if (column.markedForDrop) {
      if (!column.original) continue;
      if (column.original.is_primary_key) {
        warnings.push(`Primary key column "${column.original.name}" cannot be dropped from this editor.`);
        continue;
      }
      statements.push(`ALTER TABLE ${table} DROP COLUMN ${quoteIdent(databaseType, column.original.name)};`);
      continue;
    }

    if (!column.original) {
      statements.push(...buildAddColumnSql(databaseType, table, column));
      continue;
    }

    if (!hasExistingColumnAttributeChange(column)) continue;
    if (databaseType === "mysql") {
      statements.push(...buildMysqlExistingColumnSql(table, column));
    } else if (databaseType === "postgres") {
      statements.push(...buildPostgresExistingColumnSql(table, column));
    } else if (databaseType === "sqlite") {
      statements.push(...buildSqliteExistingColumnSql(table, column, warnings));
    } else {
      warnings.push(`Editing existing columns is not supported for ${databaseType ?? "this database"} yet.`);
    }
  }

  return statements;
}

function buildDropIndexSql(
  databaseType: DatabaseType | undefined,
  table: string,
  schema: string | undefined,
  indexName: string,
): string {
  if (databaseType === "mysql") return `DROP INDEX ${quoteIdent(databaseType, indexName)} ON ${table};`;
  if (databaseType === "sqlserver") return `DROP INDEX ${quoteIdent(databaseType, indexName)} ON ${table};`;
  if ((databaseType === "postgres" || databaseType === "oracle") && schema) {
    return `DROP INDEX ${quoteIdent(databaseType, schema)}.${quoteIdent(databaseType, indexName)};`;
  }
  return `DROP INDEX ${quoteIdent(databaseType, indexName)};`;
}

function buildIndexSql(options: BuildTableStructureChangeSqlOptions, warnings: string[]): string[] {
  const databaseType = options.databaseType;
  const table = qualifiedTable(databaseType, options.schema, options.tableName);
  const statements: string[] = [];

  for (const index of options.indexes) {
    if (index.markedForDrop) {
      if (!index.original) continue;
      if (index.original.is_primary) {
        warnings.push(`Primary index "${index.original.name}" cannot be dropped from this editor.`);
        continue;
      }
      statements.push(buildDropIndexSql(databaseType, table, options.schema, index.original.name));
      continue;
    }

    if (index.original) continue;
    const name = clean(index.name);
    const columns = index.columns.map(clean).filter(Boolean);
    if (!name || columns.length === 0) continue;
    const unique = index.isUnique ? "UNIQUE " : "";
    const cols = columns.map((column) => quoteIdent(databaseType, column)).join(", ");
    const idxType = clean(index.indexType);
    const usingClause = idxType && databaseType === "postgres" ? ` USING ${idxType}` : "";
    const typePrefix = idxType && databaseType === "sqlserver" ? `${idxType} ` : "";
    const incCols = index.includedColumns.map(clean).filter(Boolean);
    const includeClause = incCols.length > 0 && (databaseType === "postgres" || databaseType === "sqlserver") ? ` INCLUDE (${incCols.map((c) => quoteIdent(databaseType, c)).join(", ")})` : "";
    const filter = clean(index.filter);
    const supportsWhere = databaseType === "postgres" || databaseType === "sqlserver" || databaseType === "sqlite";
    const whereClause = filter && supportsWhere ? ` WHERE ${filter}` : "";
    statements.push(`CREATE ${unique}${typePrefix}INDEX ${quoteIdent(databaseType, name)} ON ${table}${usingClause} (${cols})${includeClause}${whereClause};`);
    const comment = clean(index.comment);
    if (comment && databaseType === "postgres") {
      statements.push(`COMMENT ON INDEX ${quoteIdent(databaseType, name)} IS ${quoteString(comment)};`);
    }
  }

  return statements;
}

function validateDraft(options: BuildTableStructureChangeSqlOptions): string[] {
  const warnings: string[] = [];
  const activeColumns = options.columns.filter((column) => !column.markedForDrop);
  const names = new Set<string>();

  for (const column of activeColumns) {
    if (!clean(column.name)) warnings.push("Column name cannot be empty.");
    if (!clean(column.dataType)) warnings.push(`Column "${column.name || "(new)"}" type cannot be empty.`);
    const key = clean(column.name).toLowerCase();
    if (key && names.has(key)) warnings.push(`Column "${column.name}" is duplicated.`);
    if (key) names.add(key);
  }

  for (const index of options.indexes.filter((idx) => !idx.markedForDrop && !idx.original)) {
    if (!clean(index.name)) warnings.push("Index name cannot be empty.");
    if (index.columns.map(clean).filter(Boolean).length === 0) {
      warnings.push(`Index "${index.name || "(new)"}" needs at least one column.`);
    }
  }

  return warnings;
}

export function buildTableStructureChangeSql(options: BuildTableStructureChangeSqlOptions): TableStructureChangeSql {
  const warnings = validateDraft(options);
  const statements = [
    ...buildColumnSql(options, warnings),
    ...buildIndexSql(options, warnings),
  ];

  return { statements, warnings };
}
