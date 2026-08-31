import type { DatabaseObjectType, DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";

export type RenameableObjectType = DatabaseObjectType;

export interface BuildRenameObjectSqlOptions {
  databaseType?: DatabaseType;
  objectType: RenameableObjectType;
  schema?: string | null;
  oldName: string;
  newName: string;
}

// openGauss 兼容 PostgreSQL 的 ALTER TABLE/VIEW ... RENAME TO 语法，需与 gaussdb 等 PG 系数据库同等开放重命名能力
const postgresLikeRenameTypes = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "opengauss", "kingbase", "highgo", "uxdb", "vastbase"]);

const oracleLikeRenameTypes = new Set<DatabaseType>(["oracle", "dameng"]);

export function supportsObjectRename(databaseType: DatabaseType | undefined, objectType: RenameableObjectType): boolean {
  if (!databaseType) return false;
  if (databaseType === "sqlserver") return true;
  if (objectType === "PROCEDURE" || objectType === "FUNCTION") {
    return false;
  }
  if (databaseType === "sqlite" || databaseType === "rqlite" || databaseType === "turso" || databaseType === "cloudflare-d1" || databaseType === "duckdb") return objectType === "TABLE";
  if (databaseType === "mysql" || databaseType === "goldendb") return objectType === "TABLE" || objectType === "VIEW";
  if (postgresLikeRenameTypes.has(databaseType)) return objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW";
  if (oracleLikeRenameTypes.has(databaseType)) return objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW";
  return false;
}

export function buildRenameObjectSql(options: BuildRenameObjectSqlOptions): Promise<string> {
  return api.buildRenameObjectSql(options);
}

// ── Database rename (PostgreSQL family) ──

const DATABASE_RENAME_TYPES = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "kingbase", "highgo", "uxdb", "vastbase", "opengauss"]);

export function supportsDatabaseRename(databaseType?: DatabaseType): boolean {
  return !!databaseType && DATABASE_RENAME_TYPES.has(databaseType);
}

export function databaseRenameMaintenanceDatabase(configuredDatabase: string | undefined, targetDatabase: string): string {
  if (configuredDatabase && configuredDatabase !== targetDatabase) return configuredDatabase;
  return targetDatabase === "postgres" ? "template1" : "postgres";
}

export interface BuildRenameDatabaseSqlOptions {
  databaseType?: DatabaseType;
  oldName: string;
  newName: string;
  terminateConnections?: boolean;
}

export function buildRenameDatabaseSql(options: BuildRenameDatabaseSqlOptions): Promise<string> {
  return api.buildRenameDatabaseSql({ ...options, terminateConnections: options.terminateConnections ?? false });
}

export interface BuildRenameDatabasePreflightSqlOptions {
  databaseType?: DatabaseType;
  databaseName: string;
}

export function buildRenameDatabasePreflightSql(options: BuildRenameDatabasePreflightSqlOptions): Promise<string> {
  return api.buildRenameDatabasePreflightSql(options);
}
