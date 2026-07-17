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

const postgresLikeRenameTypes = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "kingbase", "highgo", "vastbase"]);

const oracleLikeRenameTypes = new Set<DatabaseType>(["oracle", "dameng"]);

export function supportsObjectRename(databaseType: DatabaseType | undefined, objectType: RenameableObjectType): boolean {
  if (!databaseType) return false;
  if (databaseType === "sqlserver") return true;
  if (objectType === "PROCEDURE" || objectType === "FUNCTION") {
    return false;
  }
  if (databaseType === "sqlite" || databaseType === "rqlite" || databaseType === "turso" || databaseType === "cloudflare-d1") return objectType === "TABLE";
  if (databaseType === "mysql" || databaseType === "goldendb") return objectType === "TABLE" || objectType === "VIEW";
  if (postgresLikeRenameTypes.has(databaseType)) return objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW";
  if (oracleLikeRenameTypes.has(databaseType)) return objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW";
  return false;
}

export function buildRenameObjectSql(options: BuildRenameObjectSqlOptions): Promise<string> {
  return api.buildRenameObjectSql(options);
}
