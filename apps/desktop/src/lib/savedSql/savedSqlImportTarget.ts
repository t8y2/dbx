import type { SavedSqlFolder } from "@/types/database";
import type { ExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";

export function savedSqlImportTarget(sourceTarget: ExternalSqlFileTarget, folder?: Pick<SavedSqlFolder, "connectionId">): ExternalSqlFileTarget {
  if (!folder) return sourceTarget;
  return {
    connectionId: folder.connectionId,
    database: sourceTarget.connectionId === folder.connectionId ? sourceTarget.database : "",
    catalog: sourceTarget.connectionId === folder.connectionId ? sourceTarget.catalog : undefined,
  };
}
