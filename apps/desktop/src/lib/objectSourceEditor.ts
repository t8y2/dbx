import type { DatabaseType, ObjectSourceKind } from "@/types/database";
import * as api from "@/lib/api";

export type BuildEditableObjectSourceSqlInput = {
  databaseType: DatabaseType;
  objectType: ObjectSourceKind;
  schema?: string | null;
  name: string;
  source: string;
};

export type BuildRoutineRenameObjectSourceInput = BuildEditableObjectSourceSqlInput & {
  newName: string;
};

export type ObjectSourceSaveExecutionMode = "single" | "script";

const postgresLikeRoutineRenameTypes = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "kingbase", "highgo", "vastbase"]);
const mysqlLikeRoutineRenameTypes = new Set<DatabaseType>(["mysql", "goldendb"]);
const oracleLikeRoutineRenameTypes = new Set<DatabaseType>(["oracle", "dameng"]);

export function supportsSourceBackedRoutineRename(databaseType: DatabaseType | undefined, objectType: ObjectSourceKind): boolean {
  if (objectType !== "FUNCTION" && objectType !== "PROCEDURE") return false;
  if (!databaseType || databaseType === "sqlserver") return false;
  return mysqlLikeRoutineRenameTypes.has(databaseType) || postgresLikeRoutineRenameTypes.has(databaseType) || oracleLikeRoutineRenameTypes.has(databaseType);
}

export function buildRoutineRenameObjectSourceStatements(input: BuildRoutineRenameObjectSourceInput): Promise<string[]> {
  return api.buildRoutineRenameObjectSourceStatements(input);
}

export function buildExecutableObjectSourceStatements(input: BuildEditableObjectSourceSqlInput): Promise<string[]> {
  return api.buildExecutableObjectSourceStatements(input);
}

export async function buildExecutableObjectSourceSql(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return api.buildExecutableObjectSourceSql(input);
}

export function buildEditableObjectSource(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return api.buildEditableObjectSource(input);
}

export function objectSourceSaveExecutionMode(_databaseType: DatabaseType): ObjectSourceSaveExecutionMode {
  return "single";
}
