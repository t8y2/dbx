import * as api from "@/lib/backend/api";
import type { TableSchemaDetail } from "@/lib/schema/schemaDiff";
import type { FunctionInfo, TableInfo } from "@/types/database";

/**
 * A schema-only dump is read once per selected file and then reused by the
 * table picker and the comparison. The contents stay in memory only: a
 * comparison config persists the path, never the SQL, and the desktop build
 * re-reads the file when a restored config needs it.
 */

/** Automatic re-reads allow more than the SQL editor, because a full dump is large. */
export const SCHEMA_DIFF_SQL_FILE_MAX_BYTES = 256 * 1024 * 1024;

export interface SchemaDiffSqlFileSnapshot {
  tables: TableInfo[];
  details: TableSchemaDetail[];
  functions: FunctionInfo[];
  warnings: string[];
}

interface SchemaDiffSqlFileContents {
  sql: string;
  encoding?: string;
}

const contents = new Map<string, SchemaDiffSqlFileContents>();
const pendingReads = new Map<string, Promise<SchemaDiffSqlFileContents>>();
const snapshots = new Map<string, Promise<SchemaDiffSqlFileSnapshot>>();

function invalidateSnapshots(path: string): void {
  const prefix = path + "\u0000";
  for (const key of snapshots.keys()) {
    if (key.startsWith(prefix)) snapshots.delete(key);
  }
}

export function rememberSchemaDiffSqlFileContents(path: string, sql: string, encoding?: string): void {
  contents.set(path, encoding ? { sql, encoding } : { sql });
  pendingReads.delete(path);
  invalidateSnapshots(path);
}

export function hasSchemaDiffSqlFileContents(path: string | undefined): boolean {
  return !!path && contents.has(path);
}

export function forgetSchemaDiffSqlFile(path: string): void {
  contents.delete(path);
  pendingReads.delete(path);
  invalidateSnapshots(path);
}

async function readContents(path: string): Promise<SchemaDiffSqlFileContents> {
  const cached = contents.get(path);
  if (cached) return cached;
  let pending = pendingReads.get(path);
  if (!pending) {
    pending = api
      .readExternalSqlFileSnapshot(path, SCHEMA_DIFF_SQL_FILE_MAX_BYTES, "auto")
      .then((snapshot) => {
        const loaded: SchemaDiffSqlFileContents = { sql: snapshot.content, ...(snapshot.encoding ? { encoding: snapshot.encoding } : {}) };
        contents.set(path, loaded);
        return loaded;
      })
      .finally(() => pendingReads.delete(path));
    pendingReads.set(path, pending);
  }
  return pending;
}

/**
 * Parse a dump for the given FK namespace. The database name decides the
 * schema qualifier the live driver reports for foreign keys, so comparing
 * against a differently named database still pairs the keys.
 */
export async function loadSchemaDiffSqlFileSnapshot(path: string, database?: string): Promise<SchemaDiffSqlFileSnapshot> {
  const resolved = await readContents(path);
  const databaseName = database?.trim() ?? "";
  const key = path + "\u0000" + databaseName;
  const existing = snapshots.get(key);
  if (existing) return existing;
  const request = api.parseSchemaDiffSqlFile(resolved.sql, databaseName || undefined, "mysql").then((snapshot) => ({
    tables: snapshot.tables ?? [],
    details: snapshot.details ?? [],
    functions: snapshot.functions ?? [],
    warnings: snapshot.warnings ?? [],
  }));
  snapshots.set(key, request);
  request.catch(() => snapshots.delete(key));
  return request;
}
