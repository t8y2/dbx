import type { QueryTab, SavedSqlFile } from "@/types/database";
import { extractCandidateDatabaseFromName } from "@/lib/savedSql/savedSqlFileName";

export type SavedSqlOpenTargetMode = "saved" | "current";

export interface SavedSqlExecutionTarget {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
}

type SavedSqlFileTarget = Pick<SavedSqlFile, "connectionId" | "database" | "schema" | "catalog">;
type QueryTabTarget = Pick<QueryTab, "connectionId" | "database" | "schema" | "catalog">;

export function savedSqlExecutionTargetFromFile(file: SavedSqlFileTarget): SavedSqlExecutionTarget {
  return {
    connectionId: file.connectionId,
    database: file.database,
    schema: file.schema,
    catalog: file.catalog,
  };
}

export function savedSqlExecutionTargetFromTab(tab: QueryTabTarget | undefined): SavedSqlExecutionTarget | undefined {
  if (!tab?.connectionId) return undefined;
  return {
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
    catalog: tab.catalog,
  };
}

export function resolveSavedSqlExecutionTarget(file: SavedSqlFileTarget & { name?: string }, mode: SavedSqlOpenTargetMode, currentTarget?: SavedSqlExecutionTarget, fallbackDatabase?: string): SavedSqlExecutionTarget {
  if (mode === "current" && currentTarget) return { ...currentTarget };
  const target = savedSqlExecutionTargetFromFile(file);
  if (!target.database) {
    if (currentTarget?.database && (!target.connectionId || target.connectionId === currentTarget.connectionId)) {
      target.database = currentTarget.database;
      if (!target.connectionId) target.connectionId = currentTarget.connectionId;
      target.catalog ??= currentTarget.catalog;
      target.schema ??= currentTarget.schema;
    } else if (file.name) {
      const candidate = extractCandidateDatabaseFromName(file.name);
      if (candidate) target.database = candidate;
    }
    if (!target.database && fallbackDatabase) {
      target.database = fallbackDatabase;
    }
  }
  return target;
}

export function savedSqlDefaultTargetForWrite(currentTarget: SavedSqlExecutionTarget): SavedSqlFileTarget {
  return {
    connectionId: currentTarget.connectionId,
    database: currentTarget.database,
    schema: currentTarget.schema,
    catalog: currentTarget.catalog,
  };
}
