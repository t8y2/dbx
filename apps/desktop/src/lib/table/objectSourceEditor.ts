import type { DatabaseType, ObjectSourceKind } from "@/types/database";
import * as api from "@/lib/backend/api";

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

const postgresLikeRoutineRenameTypes = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "kingbase", "highgo", "uxdb", "vastbase"]);
const postgresLikeViewTypes = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "opengauss", "questdb", "kingbase", "highgo", "uxdb", "vastbase"]);
const mysqlLikeRoutineRenameTypes = new Set<DatabaseType>(["mysql", "goldendb"]);
const oracleLikeRoutineRenameTypes = new Set<DatabaseType>(["oracle", "dameng"]);

// SQLSTATE 42P16 covers unrelated invalid table definitions, so only match the
// confirmed PostgreSQL view-column errors and their localized equivalents.
const postgresViewColumnChangeErrorPatterns = [/cannot drop columns? from view/i, /cannot change name of view column/i, /cannot change data type of view column/i, /ビューからは列を削除できません/, /(?:无法|不能)从视图中删除列/];

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (message !== undefined && message !== null) return String(message);
  }
  return String(error);
}

export function formatObjectSourceSaveError(error: unknown, databaseType: DatabaseType, objectType: ObjectSourceKind, postgresViewColumnChangeHint: string): string {
  const message = errorMessage(error);
  if (objectType !== "VIEW" || !postgresLikeViewTypes.has(databaseType) || !postgresViewColumnChangeErrorPatterns.some((pattern) => pattern.test(message)) || message.includes(postgresViewColumnChangeHint)) {
    return message;
  }

  return `${message}\n\n${postgresViewColumnChangeHint}`;
}

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

export async function executeObjectSourceSave(connectionId: string, database: string, databaseType: DatabaseType, statements: string[], schema?: string): Promise<void> {
  const nonEmptyStatements = statements.filter((sql) => sql.trim().length > 0);
  if (nonEmptyStatements.length === 0) return;

  if (databaseType === "informix" && nonEmptyStatements.length > 1) {
    // Informix/GBase 8s view replacement is validate + drop/create; run it atomically
    // so a failing final CREATE rolls back the original view instead of deleting it.
    await api.executeInTransaction(connectionId, database, nonEmptyStatements, schema);
    return;
  }

  for (const sql of nonEmptyStatements) {
    if (objectSourceSaveExecutionMode(databaseType) === "single") {
      await api.executeQuery(connectionId, database, sql, schema);
    } else {
      await api.executeScript(connectionId, database, sql, schema);
    }
  }
}
