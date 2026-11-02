import type { SavedSqlFile, SavedSqlFolder } from "@/types/database";
import type { SavedSqlExecutionTarget } from "@/lib/savedSql/savedSqlExecutionTarget";

export interface SavedSqlBatchTargetSelection {
  connectionId: string;
  database: string;
  catalog?: string;
}

export interface SavedSqlBatchReassignment {
  target: SavedSqlExecutionTarget;
  folderId?: string;
}

function normalizedCatalog(catalog: string | null | undefined): string | undefined {
  return catalog || undefined;
}

export function savedSqlBatchReassignment(file: SavedSqlFile, folder: SavedSqlFolder | undefined, selection: SavedSqlBatchTargetSelection): SavedSqlBatchReassignment {
  const catalog = normalizedCatalog(selection.catalog);
  const keepsNamespace = file.connectionId === selection.connectionId && normalizedCatalog(file.catalog) === catalog && file.database === selection.database;
  return {
    target: {
      connectionId: selection.connectionId,
      database: selection.database,
      catalog,
      schema: keepsNamespace ? file.schema : undefined,
    },
    folderId: folder?.id === file.folderId ? file.folderId : undefined,
  };
}
