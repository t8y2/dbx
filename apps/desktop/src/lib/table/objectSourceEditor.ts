import type { DatabaseType, ObjectSourceKind } from "@/types/database";
import * as api from "@/lib/backend/api";
import { beginSourceSave, type SourceIdentitySnapshot } from "@/lib/table/objectSourceIdentity";

export type BuildEditableObjectSourceSqlInput = {
  databaseType: DatabaseType;
  objectType: ObjectSourceKind;
  schema?: string | null;
  name: string;
  source: string;
};

export type ValidateOracleExecutableObjectSourceInput = {
  databaseType: Extract<DatabaseType, "oracle" | "oceanbase-oracle">;
  objectType: Extract<ObjectSourceKind, "PROCEDURE" | "FUNCTION" | "PACKAGE" | "PACKAGE_BODY">;
  schema?: string | null;
  name: string;
  source: string;
};

export type FingerprintOracleRoutineObjectSourceInput = {
  databaseType: Extract<DatabaseType, "oracle" | "oceanbase-oracle">;
  objectType: Extract<ObjectSourceKind, "PROCEDURE" | "FUNCTION">;
  schema?: string | null;
  name: string;
  source: string;
};

export type BuildRoutineRenameObjectSourceInput = BuildEditableObjectSourceSqlInput & {
  newName: string;
};

export type RewriteOracleRoutineReferencesInput = {
  databaseType: DatabaseType;
  callerType: Extract<ObjectSourceKind, "VIEW" | "PROCEDURE" | "FUNCTION">;
  targetType: Extract<ObjectSourceKind, "PROCEDURE" | "FUNCTION">;
  schema?: string | null;
  oldName: string;
  newName: string;
  source: string;
};

export type ObjectSourceSaveExecutionMode = "single" | "script";

const postgresLikeRoutineRenameTypes = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "kingbase", "highgo", "uxdb", "vastbase"]);
const postgresLikeViewTypes = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "opengauss", "questdb", "kingbase", "highgo", "uxdb", "vastbase"]);
const mysqlLikeRoutineRenameTypes = new Set<DatabaseType>(["mysql", "goldendb"]);
const oracleLikeRoutineRenameTypes = new Set<DatabaseType>(["oracle", "dameng", "oceanbase-oracle"]);

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

export function fingerprintOracleRoutineObjectSource(input: FingerprintOracleRoutineObjectSourceInput): Promise<string> {
  return api.fingerprintOracleRoutineObjectSource(input);
}

export function rewriteOracleRoutineReferences(input: RewriteOracleRoutineReferencesInput): Promise<string> {
  return api.rewriteOracleRoutineReferences(input);
}

export function buildExecutableObjectSourceStatements(input: BuildEditableObjectSourceSqlInput): Promise<string[]> {
  return api.buildExecutableObjectSourceStatements(input);
}

export async function buildExecutableObjectSourceSql(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return api.buildExecutableObjectSourceSql(input);
}

export function resolveObjectSourceEditDraft(databaseType: DatabaseType | undefined, objectType: ObjectSourceKind, formatted: string, editable: string): string {
  if (databaseType === "mysql" && objectType === "VIEW" && formatted.trim()) return formatted;
  return editable;
}

export function buildEditableObjectSource(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return api.buildEditableObjectSource(input);
}

export function objectSourceSaveExecutionMode(_databaseType: DatabaseType): ObjectSourceSaveExecutionMode {
  return "single";
}

export async function executeObjectSourceSave(connectionId: string, database: string, databaseType: DatabaseType, statements: string[], schema?: string, timeoutSecs?: number): Promise<void> {
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
      if (timeoutSecs === undefined) await api.executeQuery(connectionId, database, sql, schema);
      else await api.executeQuery(connectionId, database, sql, schema, undefined, { timeoutSecs });
    } else {
      await api.executeScript(connectionId, database, sql, schema);
    }
  }
}

// Mirrors the backend's MySQL routine declaration parser: `CREATE [DEFINER = account] {PROCEDURE|FUNCTION} name (`.
const mysqlCreateRoutineHeader = /^\s*CREATE\s+(?:DEFINER\s*=\s*(?:(?:`(?:``|[^`])+`|'(?:''|[^'])+'|\S+)\s*@\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|\S+)|CURRENT_USER(?:\(\))?)\s+)?(FUNCTION|PROCEDURE)\s+(`(?:``|[^`])+`|[A-Za-z_][\w$]*)\s*\(/i;

/**
 * MySQL has no CREATE OR REPLACE for stored routines, so the CREATE statement a routine source tab shows fails with
 * "already exists" when it is simply run. Saving replaces the routine safely (validate the new body under a temporary
 * name, DROP ... IF EXISTS, CREATE); running the tab's CREATE needs the same statements ahead of it.
 */
export function supportsRoutineSourceReplaceOnRun(databaseType: DatabaseType | undefined, objectType: ObjectSourceKind): boolean {
  return (objectType === "PROCEDURE" || objectType === "FUNCTION") && !!databaseType && mysqlLikeRoutineRenameTypes.has(databaseType);
}

// Only a plain `CREATE <same kind> <same unqualified name>(...)` replaces the tab's routine. Renames, other routines,
// `IF NOT EXISTS` and schema-qualified targets keep the normal CREATE semantics.
function createsSourceRoutine(objectType: ObjectSourceKind, name: string, sql: string): boolean {
  const header = mysqlCreateRoutineHeader.exec(sql);
  if (!header || header[1].toUpperCase() !== objectType) return false;
  const declared = header[2].startsWith("`") ? header[2].slice(1, -1).replaceAll("``", "`") : header[2];
  return declared.toLowerCase() === name.toLowerCase();
}

export type RoutineSourceRunPreparationInput = {
  identity: SourceIdentitySnapshot;
  connectionId: string;
  database: string;
  databaseType: DatabaseType;
  schema: string;
  objectType: ObjectSourceKind;
  name: string;
  /** The single statement about to run. */
  sql: string;
};

/**
 * Executes the Save sequence up to, but excluding, its final CREATE so that `sql` itself can then run through the
 * normal query pipeline (results, error positions and history stay untouched). The new body is validated under a
 * temporary name before the existing routine is dropped, so a syntax error never leaves the routine deleted.
 * Returns false, executing nothing, when `sql` is not a plain CREATE of the tab's routine.
 */
export async function prepareRoutineSourceRun(input: RoutineSourceRunPreparationInput): Promise<boolean> {
  const { databaseType, objectType, name, sql } = input;
  if (!supportsRoutineSourceReplaceOnRun(databaseType, objectType) || !createsSourceRoutine(objectType, name, sql)) return false;

  const statements = await buildExecutableObjectSourceStatements({ databaseType, objectType, schema: input.schema, name, source: sql });
  // A trailing DROP means the backend treated the CREATE as a rename, which Run must not turn into a replace.
  if (statements.length < 2 || !/^\s*CREATE\b/i.test(statements[statements.length - 1])) return false;

  const release = beginSourceSave(input.identity);
  try {
    await executeObjectSourceSave(input.connectionId, input.database, databaseType, statements.slice(0, -1), input.schema);
  } finally {
    release();
  }
  return true;
}
