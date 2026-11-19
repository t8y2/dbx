import type { SavedSqlFolder } from "@/types/database";
import type { ExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";

export function savedSqlImportTarget(sourceTarget: ExternalSqlFileTarget, folder?: Pick<SavedSqlFolder, "connectionId">, fallbackDatabase?: string): ExternalSqlFileTarget {
  if (!folder) {
    return {
      connectionId: sourceTarget.connectionId,
      database: sourceTarget.database || fallbackDatabase || "",
      catalog: sourceTarget.catalog,
      schema: sourceTarget.schema,
    };
  }
  return {
    connectionId: folder.connectionId,
    database: (sourceTarget.connectionId === folder.connectionId ? sourceTarget.database : "") || fallbackDatabase || "",
    catalog: sourceTarget.connectionId === folder.connectionId ? sourceTarget.catalog : undefined,
    schema: sourceTarget.connectionId === folder.connectionId ? sourceTarget.schema : undefined,
  };
}
