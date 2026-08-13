import type { ColumnInfo, DatabaseObjectType, DatabaseType, ForeignKeyInfo, IndexInfo, TriggerInfo } from "@/types/database";
import * as api from "@/lib/backend/api";
import { createColumnDrafts, createForeignKeyDrafts, createIndexDrafts, createTriggerDrafts } from "@/lib/table/tableStructureEditorState";
import type { BuildTableStructureChangeSqlOptions } from "@/lib/table/tableStructureEditorSql";

export interface DropObjectSqlOptions {
  databaseType?: DatabaseType;
  objectType: DatabaseObjectType;
  schema?: string | null;
  name: string;
  signature?: string | null;
}

export interface TableAdminSqlOptions {
  databaseType?: DatabaseType;
  schema?: string | null;
  tableName: string;
  cascade?: boolean;
}

export type TableChildObjectType = "COLUMN" | "INDEX" | "FOREIGN_KEY" | "TRIGGER";

export interface DropTableChildObjectSqlOptions {
  databaseType?: DatabaseType;
  objectType: TableChildObjectType;
  schema?: string | null;
  tableName: string;
  name: string;
}

export interface DatabaseNameSqlOptions {
  databaseType?: DatabaseType;
  name: string;
}

export interface SchemaNameSqlOptions {
  databaseType?: DatabaseType;
  name: string;
}

export interface SchemaCommentSqlOptions extends SchemaNameSqlOptions {
  comment: string;
}

export interface DatabasePropertyEditSqlOptions {
  databaseType?: DatabaseType;
  driverProfile?: string | null;
  target: "database" | "schema";
  name: string;
  charset?: string;
  collation?: string;
  comment?: string;
}

export interface DuplicateTableStructureSqlOptions {
  databaseType?: DatabaseType;
  schema?: string | null;
  sourceName: string;
  targetName: string;
  tableComment?: string | null;
  columnComments?: Array<{ name: string; comment: string }>;
}

export interface DuplicateTableStructurePlanOptions extends DuplicateTableStructureSqlOptions {
  connectionId: string;
  database: string;
  catalog?: string;
  sourceColumns?: ColumnInfo[];
}

export interface DuplicateTableStructurePlan {
  sql: string;
  sourceColumns?: ColumnInfo[];
  executeAsScript: boolean;
}

export function collectDuplicateTableColumnComments(columns: readonly Pick<ColumnInfo, "name" | "comment">[]): Array<{ name: string; comment: string }> {
  return columns.flatMap((column) => {
    const comment = column.comment;
    return comment?.trim() ? [{ name: column.name, comment }] : [];
  });
}

const ORACLE_LEGACY_IDENTIFIER_LIMIT = 30;
const DAMENG_IDENTIFIER_LIMIT = 128;

function oracleCloneObjectName(targetName: string, kind: string, index: number): string {
  const normalized =
    targetName
      .trim()
      .replace(/[^a-zA-Z0-9_$#]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "TABLE";
  const suffix = `_${kind}${index + 1}`;
  return `${normalized.slice(0, Math.max(1, ORACLE_LEGACY_IDENTIFIER_LIMIT - suffix.length))}${suffix}`;
}

export function oracleDuplicateTableCreateOptions(options: { schema?: string | null; targetName: string; tableComment?: string | null; columns: ColumnInfo[]; indexes: IndexInfo[]; foreignKeys: ForeignKeyInfo[]; triggers: TriggerInfo[] }): BuildTableStructureChangeSqlOptions {
  return {
    databaseType: "oracle",
    schema: options.schema || undefined,
    tableName: options.targetName,
    tableComment: options.tableComment || undefined,
    columns: createColumnDrafts(options.columns, "oracle").map((column, index) => ({
      ...column,
      id: `clone:column:${index}`,
      original: undefined,
      originalPosition: undefined,
    })),
    indexes: createIndexDrafts(options.indexes)
      .filter((index) => !index.isPrimary)
      .map((index, position) => ({
        ...index,
        id: `clone:index:${position}`,
        name: oracleCloneObjectName(options.targetName, "IDX", position),
        nameEdited: true,
        original: undefined,
      })),
    foreignKeys: createForeignKeyDrafts(options.foreignKeys).map((foreignKey, index) => ({
      ...foreignKey,
      id: `clone:foreign-key:${index}`,
      name: oracleCloneObjectName(options.targetName, "FK", index),
      original: undefined,
    })),
    triggers: createTriggerDrafts(options.triggers).map((trigger, index) => ({
      ...trigger,
      id: `clone:trigger:${index}`,
      name: oracleCloneObjectName(options.targetName, "TRG", index),
      original: undefined,
    })),
  };
}

function damengDuplicateTableName(targetName: string): string {
  const hasLower = /[a-z]/.test(targetName);
  const hasUpper = /[A-Z]/.test(targetName);
  const hasSpecial = /[^a-zA-Z0-9_$#]/.test(targetName);
  const hasInvalidStart = !/^[a-zA-Z_]/.test(targetName);
  return (hasLower && hasUpper) || hasSpecial || hasInvalidStart ? targetName : targetName.toUpperCase();
}

function damengCloneIndexName(targetName: string, index: number): string {
  const normalized =
    targetName
      .trim()
      .replace(/[^\p{L}\p{N}_$#]+/gu, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "TABLE";
  const suffix = `_IDX${index + 1}`;
  const prefixLength = Math.max(1, DAMENG_IDENTIFIER_LIMIT - Array.from(suffix).length);
  return `${Array.from(normalized).slice(0, prefixLength).join("")}${suffix}`;
}

function isSupportedDamengCloneIndex(index: IndexInfo): boolean {
  if (index.is_primary) return false;
  const indexType = (index.index_type ?? "").trim().toUpperCase();
  if (indexType.includes("INNER") || indexType.includes("INTERNAL")) return false;
  return indexType === "" || indexType === "NORMAL" || indexType === "BITMAP";
}

export function damengDuplicateTableCreateOptions(options: { schema?: string | null; targetName: string; tableComment?: string | null; columns: ColumnInfo[]; indexes: IndexInfo[] }): BuildTableStructureChangeSqlOptions {
  return {
    databaseType: "dameng",
    schema: options.schema || undefined,
    tableName: damengDuplicateTableName(options.targetName),
    tableComment: options.tableComment || undefined,
    columns: createColumnDrafts(options.columns, "dameng").map((column, index) => ({
      ...column,
      id: `clone:column:${index}`,
      original: undefined,
      originalPosition: undefined,
    })),
    indexes: createIndexDrafts(options.indexes.filter(isSupportedDamengCloneIndex)).map((index, position) => ({
      ...index,
      id: `clone:index:${position}`,
      name: damengCloneIndexName(options.targetName, position),
      nameEdited: true,
      original: undefined,
    })),
    foreignKeys: [],
    triggers: [],
  };
}

export async function buildDuplicateTableStructurePlan(options: DuplicateTableStructurePlanOptions): Promise<DuplicateTableStructurePlan> {
  if (options.databaseType === "oracle") {
    const columnsPromise = options.sourceColumns ? Promise.resolve(options.sourceColumns) : api.getColumns(options.connectionId, options.database, options.schema || "", options.sourceName, options.catalog);
    const tableCommentPromise =
      options.tableComment == null
        ? api.getTableComment(options.connectionId, options.database, options.schema || "", options.sourceName, options.catalog).catch((error) => {
            console.warn(`Failed to load Oracle table comment for table clone: ${options.sourceName}`, error);
            return null;
          })
        : Promise.resolve(options.tableComment);
    const [columns, indexes, foreignKeys, triggers, tableComment] = await Promise.all([
      columnsPromise,
      api.listIndexes(options.connectionId, options.database, options.schema || "", options.sourceName, options.catalog),
      api.listForeignKeys(options.connectionId, options.database, options.schema || "", options.sourceName, options.catalog),
      api.listTriggers(options.connectionId, options.database, options.schema || "", options.sourceName, options.catalog),
      tableCommentPromise,
    ]);
    const result = await api.buildCreateTableSql(
      oracleDuplicateTableCreateOptions({
        schema: options.schema,
        targetName: options.targetName,
        tableComment,
        columns,
        indexes,
        foreignKeys,
        triggers,
      }),
    );
    if (result.warnings.length > 0 || result.statements.length === 0) {
      throw new Error(result.warnings.join("\n") || "Failed to generate Oracle clone DDL.");
    }
    return { sql: result.statements.join("\n"), sourceColumns: columns, executeAsScript: true };
  }

  if (options.databaseType === "dameng") {
    const columnsPromise = options.sourceColumns ? Promise.resolve(options.sourceColumns) : api.getColumns(options.connectionId, options.database, options.schema || "", options.sourceName, options.catalog);
    const [columns, indexes] = await Promise.all([columnsPromise, api.listIndexes(options.connectionId, options.database, options.schema || "", options.sourceName, options.catalog)]);
    const result = await api.buildCreateTableSql(
      damengDuplicateTableCreateOptions({
        schema: options.schema,
        targetName: options.targetName,
        tableComment: options.tableComment,
        columns,
        indexes,
      }),
    );
    if (result.warnings.length > 0 || result.statements.length === 0) {
      throw new Error(result.warnings.join("\n") || "Failed to generate Dameng clone DDL.");
    }
    return { sql: result.statements.join("\n"), sourceColumns: columns, executeAsScript: true };
  }

  const sql = await buildDuplicateTableStructureSql({
    databaseType: options.databaseType,
    schema: options.schema,
    sourceName: options.sourceName,
    targetName: options.targetName,
    tableComment: options.tableComment,
    columnComments: [],
  });
  return { sql, sourceColumns: options.sourceColumns, executeAsScript: duplicateTableStructureRequiresScript(sql) };
}

export interface CopyTableDataSqlOptions {
  databaseType?: DatabaseType;
  schema?: string | null;
  sourceName: string;
  targetName: string;
  columns?: string[];
  postgresOverridingSystemValue?: boolean;
  sqlserverIdentityInsert?: boolean;
  normalizeNewTargetName?: boolean;
}

export function buildDropObjectSql(options: DropObjectSqlOptions): Promise<string> {
  return api.buildDropObjectSql(options);
}

export function buildDropTableSql(options: TableAdminSqlOptions): Promise<string> {
  return api.buildDropTableSql(options);
}

export function buildDropTableChildObjectSql(options: DropTableChildObjectSqlOptions): Promise<string> {
  return api.buildDropTableChildObjectSql(options);
}

export function buildEmptyTableSql(options: TableAdminSqlOptions): Promise<string> {
  return api.buildEmptyTableSql(options);
}

export function buildTruncateTableSql(options: TableAdminSqlOptions): Promise<string> {
  return api.buildTruncateTableSql(options);
}

const DROP_TABLE_CASCADE_DATABASE_TYPES: readonly DatabaseType[] = ["postgres", "redshift", "gaussdb", "kwdb", "kingbase", "highgo", "uxdb", "vastbase", "opengauss"];
const TRUNCATE_TABLE_CASCADE_DATABASE_TYPES: readonly DatabaseType[] = ["postgres", "gaussdb", "kwdb", "kingbase", "highgo", "uxdb", "vastbase", "opengauss"];

export function supportsDropTableCascade(databaseType?: DatabaseType): boolean {
  return !!databaseType && DROP_TABLE_CASCADE_DATABASE_TYPES.includes(databaseType);
}

export function supportsTruncateTableCascade(databaseType?: DatabaseType): boolean {
  return !!databaseType && TRUNCATE_TABLE_CASCADE_DATABASE_TYPES.includes(databaseType);
}

export function buildDropDatabaseSql(options: DatabaseNameSqlOptions): Promise<string> {
  return api.buildDropDatabaseSql(options);
}

export function buildCreateSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return api.buildCreateSchemaSql(options);
}

export function buildDropSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return api.buildDropSchemaSql(options);
}

export function damengDropSchemaExecutionSchema(username: string | null | undefined, targetSchema: string): string | null {
  const executionSchema = username?.trim();
  const normalizedTargetSchema = targetSchema.trim().toUpperCase();
  if (!executionSchema || !normalizedTargetSchema || executionSchema.toUpperCase() === normalizedTargetSchema) return null;
  return executionSchema;
}

export function supportsSchemaComment(databaseType?: DatabaseType): boolean {
  return ["postgres", "gaussdb", "kwdb", "kingbase", "highgo", "uxdb", "vastbase", "opengauss", "yashandb"].includes(databaseType || "");
}

export function buildUpdateDatabasePropertiesSql(options: DatabasePropertyEditSqlOptions): Promise<string> {
  return api.buildUpdateDatabasePropertiesSql(options);
}

export function buildGetDatabaseCommentSql(options: DatabaseNameSqlOptions): string {
  if (!supportsSchemaComment(options.databaseType)) {
    throw new Error("Database comments are not supported by this database");
  }
  return ["SELECT pg_catalog.shobj_description(db.oid, 'pg_database') AS comment", "FROM pg_catalog.pg_database db", `WHERE db.datname = ${quoteSqlLiteral(options.name)};`].join("\n");
}

export function buildGetSchemaCommentSql(options: SchemaNameSqlOptions): string {
  if (!supportsSchemaComment(options.databaseType)) {
    throw new Error("Schema comments are not supported by this database");
  }
  return ["SELECT d.description AS comment", "FROM pg_catalog.pg_namespace n", "LEFT JOIN pg_catalog.pg_description d ON d.objoid = n.oid AND d.objsubid = 0 AND d.classoid = 'pg_namespace'::regclass", `WHERE n.nspname = ${quoteSqlLiteral(options.name)};`].join("\n");
}

export function buildSetSchemaCommentSql(options: SchemaCommentSqlOptions): string {
  if (!supportsSchemaComment(options.databaseType)) {
    throw new Error("Schema comments are not supported by this database");
  }
  const comment = options.comment.trim();
  const literal = comment ? quoteSqlLiteral(comment) : "NULL";
  return `COMMENT ON SCHEMA ${quotePostgresIdentifier(options.name)} IS ${literal};`;
}

export function buildDuplicateTableStructureSql(options: DuplicateTableStructureSqlOptions): Promise<string> {
  return api.buildDuplicateTableStructureSql(options);
}

export function duplicateTableStructureRequiresScript(sql: string): boolean {
  return /;\s*\n\s*COMMENT ON (?:TABLE|COLUMN)\b/i.test(sql);
}

export function buildCopyTableDataSql(options: CopyTableDataSqlOptions): Promise<string> {
  return api.buildCopyTableDataSql(options);
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildCreateExtensionSql(name: string, schema?: string | null): string {
  const extName = quotePostgresIdentifier(name);
  if (schema) {
    return `CREATE EXTENSION ${extName} WITH SCHEMA ${quotePostgresIdentifier(schema)};`;
  }
  return `CREATE EXTENSION ${extName};`;
}

export function buildDropExtensionSql(name: string, cascade = false): string {
  const extName = quotePostgresIdentifier(name);
  return cascade ? `DROP EXTENSION ${extName} CASCADE;` : `DROP EXTENSION ${extName};`;
}

export function buildListAvailableExtensionsSql(schema?: string | null): string {
  // pg_available_extensions shows extensions available for installation
  if (schema) {
    return `SELECT name, default_version, comment FROM pg_catalog.pg_available_extensions WHERE installed_version IS NULL ORDER BY name`;
  }
  return `SELECT name, default_version, comment FROM pg_catalog.pg_available_extensions WHERE installed_version IS NULL ORDER BY name`;
}
