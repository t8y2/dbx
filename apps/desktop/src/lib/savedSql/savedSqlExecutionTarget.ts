import type { QueryTab, SavedSqlFile } from "@/types/database";

export type SavedSqlOpenTargetMode = "saved" | "current";

export interface SavedSqlExecutionTarget {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
}

type SavedSqlFileTarget = Pick<SavedSqlFile, "connectionId" | "database" | "schema">;
type QueryTabTarget = Pick<QueryTab, "connectionId" | "database" | "schema" | "catalog">;

export function savedSqlExecutionTargetFromFile(file: SavedSqlFileTarget): SavedSqlExecutionTarget {
  return {
    connectionId: file.connectionId,
    database: file.database,
    schema: file.schema,
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

export function resolveSavedSqlExecutionTarget(file: SavedSqlFileTarget, mode: SavedSqlOpenTargetMode, currentTarget?: SavedSqlExecutionTarget): SavedSqlExecutionTarget {
  if (mode === "current" && currentTarget) return { ...currentTarget };
  return savedSqlExecutionTargetFromFile(file);
}

export function savedSqlDefaultTargetForWrite(currentTarget: SavedSqlExecutionTarget, existingFile?: SavedSqlFileTarget): SavedSqlFileTarget {
  if (existingFile) return savedSqlExecutionTargetFromFile(existingFile);
  return {
    connectionId: currentTarget.connectionId,
    database: currentTarget.database,
    schema: currentTarget.schema,
  };
}
